// MMDEncoder MMD export plugin.
//
// A DMO video encoder MMD lists under "AVI output > video codec" as "MMDEncoder".
// MMD's rendered frames are piped into FFmpeg using the preset chosen in
// MMDEncoder; MMD itself only receives a 16-byte placeholder per frame, so its
// AVI stays tiny. After the render, MMDEncoder's finish step adds the audio
// (cut from the project's WAV when the export did not start at frame 0) and
// deletes the placeholder AVI.
//
// The heavy lifting runs in MMDEncoder.exe in Node mode (backend/mmd-export.cjs):
//   plan   -> FFmpeg command for this render (presets live only in MMDEncoder)
//   finish -> audio merge and cleanup, in the background after MMD is done
// Settings: %LOCALAPPDATA%\MMDEncoder\mmd-plugin\mmd-export.json (written by the app)
// Logs:     %LOCALAPPDATA%\MMDEncoder\mmd-plugin\logs\plugin-*.log

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <tlhelp32.h>
#include <cguid.h>
#include <knownfolders.h>
#include <mediaobj.h>
#include <dmo.h>
#include <uuids.h>
#include <amvideo.h>
#include <strmif.h>
#include <shlobj.h>
#include <shellapi.h>
#include <winternl.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#pragma comment(lib, "msdmo.lib")
#pragma comment(lib, "dmoguids.lib")
#pragma comment(lib, "strmiids.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "user32.lib")

// {DC3F6BD1-923F-467A-BF73-F115AF705033}
static const GUID CLSID_MMDEncoderPlugin = {
    0xdc3f6bd1, 0x923f, 0x467a, {0xbf, 0x73, 0xf1, 0x15, 0xaf, 0x70, 0x50, 0x33}};
static const wchar_t* kClsidText = L"{DC3F6BD1-923F-467A-BF73-F115AF705033}";
static const wchar_t* kClsidBare = L"DC3F6BD1-923F-467A-BF73-F115AF705033";
// ASCII only: MMD is a Japanese ANSI program and garbles other names.
static const wchar_t* kName = L"MMDEncoder";
static const wchar_t* kCategoryBare = L"33d9a760-90c8-11d0-bd43-00a0c911ce86";
static const DWORD kFourcc = MAKEFOURCC('M', 'M', 'D', 'E');
static const GUID MEDIASUBTYPE_MMDE = {
    kFourcc, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
static const DWORD kPlaceholderBytes = 16;

static HMODULE g_module = nullptr;
static std::atomic<long> g_objects{0};
static std::atomic<long> g_locks{0};

// ------------------------------------------------------------- strings ---

static std::wstring utf16(const std::string& s, UINT cp = CP_UTF8) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(cp, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(cp, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}
static std::string utf8(const std::wstring& w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}
static std::wstring guidText(const GUID& g) {
  wchar_t s[64];
  StringFromGUID2(g, s, 64);
  return s;
}

static std::wstring pluginDir() {
  PWSTR base = nullptr;
  std::wstring dir;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &base))) {
    dir = std::wstring(base) + L"\\MMDEncoder\\mmd-plugin";
    CoTaskMemFree(base);
  }
  return dir;
}

// ------------------------------------------------------------- logging ---

class Log {
 public:
  static Log& get() {
    static Log log;
    return log;
  }
  void line(const std::wstring& text) {
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    open();
    if (file_ == INVALID_HANDLE_VALUE) return;
    SYSTEMTIME st;
    GetLocalTime(&st);
    wchar_t head[48];
    swprintf_s(head, L"[%02d:%02d:%02d.%03d] ", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    std::string bytes = utf8(head + text) + "\r\n";
    DWORD written = 0;
    WriteFile(file_, bytes.data(), (DWORD)bytes.size(), &written, nullptr);
  }
  std::wstring dir() {
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    open();
    return dir_;
  }
  std::wstring path() {
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    open();
    return path_;
  }

 private:
  void open() {
    if (opened_) return;
    opened_ = true;
    dir_ = pluginDir() + L"\\logs";
    SHCreateDirectoryExW(nullptr, dir_.c_str(), nullptr);
    SYSTEMTIME st;
    GetLocalTime(&st);
    wchar_t name[96];
    swprintf_s(name, L"\\plugin-%04d%02d%02d-%02d%02d%02d-%lu.log", st.wYear, st.wMonth, st.wDay,
               st.wHour, st.wMinute, st.wSecond, GetCurrentProcessId());
    path_ = dir_ + name;
    file_ = CreateFileW(path_.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr, OPEN_ALWAYS,
                        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file_ != INVALID_HANDLE_VALUE) {
      DWORD written = 0;
      WriteFile(file_, "\xEF\xBB\xBF", 3, &written, nullptr);
    }
  }
  std::recursive_mutex mutex_;
  bool opened_ = false;
  HANDLE file_ = INVALID_HANDLE_VALUE;
  std::wstring dir_, path_;
};

static double seconds() {
  static const double freq = [] {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return (double)f.QuadPart;
  }();
  LARGE_INTEGER now;
  QueryPerformanceCounter(&now);
  return now.QuadPart / freq;
}

static void plog(const wchar_t* fmt, ...) {
  wchar_t buf[4096];
  va_list args;
  va_start(args, fmt);
  _vsnwprintf_s(buf, _TRUNCATE, fmt, args);
  va_end(args);
  Log::get().line(buf);
}

// ---------------------------------------------------------------- JSON ---
// Just enough JSON for mmd-export.json and the helper's reply.

struct Json {
  enum Type { Null, Bool, Number, String, Array, Object } type = Null;
  bool b = false;
  double n = 0;
  std::wstring s;
  std::vector<Json> a;
  std::map<std::wstring, Json> o;
  const Json& operator[](const wchar_t* key) const {
    static const Json none;
    auto it = o.find(key);
    return it == o.end() ? none : it->second;
  }
};

class JsonReader {
 public:
  explicit JsonReader(const std::string& text) : t_(text) {}
  bool parse(Json& out) {
    try {
      out = value();
      return true;
    } catch (...) {
      return false;
    }
  }

 private:
  void ws() {
    while (i_ < t_.size() && isspace((unsigned char)t_[i_])) i_++;
  }
  char peek() {
    ws();
    if (i_ >= t_.size()) throw 0;
    return t_[i_];
  }
  void expect(char c) {
    if (peek() != c) throw 0;
    i_++;
  }
  Json value() {
    Json j;
    char c = peek();
    if (c == '{') {
      j.type = Json::Object;
      i_++;
      if (peek() == '}') return i_++, j;
      for (;;) {
        std::wstring key = string();
        expect(':');
        j.o[key] = value();
        if (peek() == ',') {
          i_++;
          continue;
        }
        expect('}');
        return j;
      }
    }
    if (c == '[') {
      j.type = Json::Array;
      i_++;
      if (peek() == ']') return i_++, j;
      for (;;) {
        j.a.push_back(value());
        if (peek() == ',') {
          i_++;
          continue;
        }
        expect(']');
        return j;
      }
    }
    if (c == '"') {
      j.type = Json::String;
      j.s = string();
      return j;
    }
    if (t_.compare(i_, 4, "true") == 0) return i_ += 4, j.type = Json::Bool, j.b = true, j;
    if (t_.compare(i_, 5, "false") == 0) return i_ += 5, j.type = Json::Bool, j;
    if (t_.compare(i_, 4, "null") == 0) return i_ += 4, j;
    size_t end = i_;
    while (end < t_.size() && strchr("+-0123456789.eE", t_[end])) end++;
    if (end == i_) throw 0;
    j.type = Json::Number;
    j.n = atof(t_.substr(i_, end - i_).c_str());
    i_ = end;
    return j;
  }
  std::wstring string() {
    expect('"');
    std::string bytes;
    while (i_ < t_.size() && t_[i_] != '"') {
      char c = t_[i_++];
      if (c != '\\') {
        bytes += c;
        continue;
      }
      char e = t_.at(i_++);
      switch (e) {
        case 'n': bytes += '\n'; break;
        case 't': bytes += '\t'; break;
        case 'r': bytes += '\r'; break;
        case 'b': bytes += '\b'; break;
        case 'f': bytes += '\f'; break;
        case 'u': {
          unsigned cp = std::stoul(t_.substr(i_, 4), nullptr, 16);
          i_ += 4;
          if (cp >= 0xD800 && cp < 0xDC00 && t_.compare(i_, 2, "\\u") == 0) {
            unsigned lo = std::stoul(t_.substr(i_ + 2, 4), nullptr, 16);
            i_ += 6;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          std::wstring w;
          if (cp >= 0x10000) {
            w += (wchar_t)(0xD800 + ((cp - 0x10000) >> 10));
            w += (wchar_t)(0xDC00 + ((cp - 0x10000) & 0x3FF));
          } else {
            w += (wchar_t)cp;
          }
          bytes += utf8(w);
          break;
        }
        default: bytes += e;
      }
    }
    expect('"');
    return utf16(bytes);
  }
  const std::string& t_;
  size_t i_ = 0;
};

static std::string jsonString(const std::wstring& w) {
  std::string out = "\"";
  for (unsigned char c : utf8(w)) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += (char)c;
    } else if (c < 0x20) {
      char buf[8];
      sprintf_s(buf, "\\u%04x", c);
      out += buf;
    } else {
      out += (char)c;
    }
  }
  return out + "\"";
}

static bool readFile(const std::wstring& path, std::string& out);

// ------------------------------------------------------ settings window ---
// MMD's "詳細設定" for this codec: the same choices as MMDEncoder's preset
// manager (preset, follow MMD's size and frame rate, alpha mask, audio fade). The choice is
// saved to mmd-selection.json, which MMDEncoder also reads and writes; MMDEncoder adopts a
// choice saved here as soon as it lands.

enum { IDC_PRESET = 101, IDC_FOLLOW = 102, IDC_FADE = 103, IDC_MASK = 104, IDC_OPEN_APP = 105 };
static const double kFades[] = {0, 0.5, 1, 2};
static const wchar_t* kFadeNames[] = {L"关闭", L"0.5 秒", L"1 秒", L"2 秒"};
// Alpha mask: the choice overrides the preset's own alpha setting.
static const char* kMaskModes[] = {"off", "with", "only"};
static const wchar_t* kMaskNames[] = {L"不导出", L"同时导出遮罩", L"仅导出遮罩"};

struct SettingsContext {
  struct Preset {
    std::wstring id, name;
    int mask;  // what the preset does by itself: index into kMaskModes
  };
  std::vector<Preset> presets;
  std::wstring presetId;
  bool followMmd = true;
  int maskMode = -1;  // index into kMaskModes; -1 = saved by 1.4.1, the preset decides
  double audioFade = 0;
  std::wstring appExe;  // MMDEncoder.exe, from mmd-export.json
};

// Picking a preset that writes a mask by itself sets the mask choice to match.
static void presetPicked(HWND dlg, SettingsContext* ctx, bool initial) {
  int i = (int)SendDlgItemMessageW(dlg, IDC_PRESET, CB_GETCURSEL, 0, 0);
  int own = i >= 0 && i < (int)ctx->presets.size() ? ctx->presets[i].mask : 0;
  int mode = (int)SendDlgItemMessageW(dlg, IDC_MASK, CB_GETCURSEL, 0, 0);
  if (initial ? ctx->maskMode < 0 : own != 0) mode = own;
  SendDlgItemMessageW(dlg, IDC_MASK, CB_SETCURSEL, mode < 0 ? 0 : mode, 0);
}

// In-memory dialog template (no .rc file needed).
class DialogTemplate {
 public:
  DialogTemplate(const wchar_t* title, short w, short h) {
    align(4);
    DLGTEMPLATE t{};
    t.style = DS_MODALFRAME | DS_SETFONT | DS_CENTER | WS_POPUP | WS_CAPTION | WS_SYSMENU;
    t.cx = w;
    t.cy = h;
    countAt_ = add(&t, sizeof(t)) + offsetof(DLGTEMPLATE, cdit);
    word(0);  // no menu
    word(0);  // default class
    text(title);
    word(9);  // font size
    text(L"Microsoft YaHei UI");
  }
  void control(WORD id, WORD cls, DWORD style, short x, short y, short w, short h, const wchar_t* text_) {
    align(4);
    DLGITEMTEMPLATE it{};
    it.style = style | WS_CHILD | WS_VISIBLE;
    it.x = x, it.y = y, it.cx = w, it.cy = h, it.id = id;
    add(&it, sizeof(it));
    word(0xFFFF);
    word(cls);
    text(text_);
    word(0);  // no creation data
    reinterpret_cast<DLGTEMPLATE*>(data_.data())->cdit++;
  }
  const DLGTEMPLATE* get() const { return reinterpret_cast<const DLGTEMPLATE*>(data_.data()); }

 private:
  size_t add(const void* p, size_t n) {
    size_t at = data_.size();
    data_.resize(at + n);
    memcpy(data_.data() + at, p, n);
    return at;
  }
  void word(WORD w) { add(&w, sizeof(w)); }
  void text(const wchar_t* s) { add(s, (wcslen(s) + 1) * sizeof(wchar_t)); }
  void align(size_t n) { data_.resize((data_.size() + n - 1) / n * n); }
  std::vector<BYTE> data_;
  size_t countAt_ = 0;
};

static INT_PTR CALLBACK settingsProc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp) {
  auto* ctx = reinterpret_cast<SettingsContext*>(GetWindowLongPtrW(dlg, DWLP_USER));
  if (msg == WM_INITDIALOG) {
    ctx = reinterpret_cast<SettingsContext*>(lp);
    SetWindowLongPtrW(dlg, DWLP_USER, lp);
    HWND presets = GetDlgItem(dlg, IDC_PRESET);
    int selected = -1;
    for (size_t i = 0; i < ctx->presets.size(); i++) {
      SendMessageW(presets, CB_ADDSTRING, 0, (LPARAM)ctx->presets[i].name.c_str());
      if (ctx->presets[i].id == ctx->presetId) selected = (int)i;
    }
    SendMessageW(presets, CB_SETCURSEL, selected, 0);
    CheckDlgButton(dlg, IDC_FOLLOW, ctx->followMmd ? BST_CHECKED : BST_UNCHECKED);
    HWND fade = GetDlgItem(dlg, IDC_FADE);
    int fadeIndex = 0;
    for (int i = 0; i < 4; i++) {
      SendMessageW(fade, CB_ADDSTRING, 0, (LPARAM)kFadeNames[i]);
      if (kFades[i] == ctx->audioFade) fadeIndex = i;
    }
    SendMessageW(fade, CB_SETCURSEL, fadeIndex, 0);
    HWND mask = GetDlgItem(dlg, IDC_MASK);
    for (int i = 0; i < 3; i++) SendMessageW(mask, CB_ADDSTRING, 0, (LPARAM)kMaskNames[i]);
    SendMessageW(mask, CB_SETCURSEL, ctx->maskMode < 0 ? 0 : ctx->maskMode, 0);
    presetPicked(dlg, ctx, true);
    return TRUE;
  }
  // Open MMDEncoder (an open one comes to the front) to manage presets and exports.
  if (msg == WM_COMMAND && LOWORD(wp) == IDC_OPEN_APP && HIWORD(wp) == BN_CLICKED) {
    const std::wstring& exe = ctx->appExe;
    const size_t slash = exe.find_last_of(L"\\/");
    if (exe.empty() || GetFileAttributesW(exe.c_str()) == INVALID_FILE_ATTRIBUTES ||
        (INT_PTR)ShellExecuteW(dlg, L"open", exe.c_str(), nullptr,
                               slash == std::wstring::npos ? nullptr : exe.substr(0, slash).c_str(),
                               SW_SHOWNORMAL) <= 32)
      MessageBoxW(dlg, L"找不到 MMDEncoder。\n\n可能已移动或删除；请手动打开 MMDEncoder，它会自动更新这里记录的位置。",
                  L"MMDEncoder", MB_OK | MB_ICONWARNING);
    return TRUE;
  }
  if (msg == WM_COMMAND && LOWORD(wp) == IDC_PRESET && HIWORD(wp) == CBN_SELCHANGE) {
    presetPicked(dlg, ctx, false);
    return TRUE;
  }
  if (msg == WM_COMMAND && (LOWORD(wp) == IDOK || LOWORD(wp) == IDCANCEL)) {
    if (LOWORD(wp) == IDOK) {
      int i = (int)SendDlgItemMessageW(dlg, IDC_PRESET, CB_GETCURSEL, 0, 0);
      if (i < 0 || i >= (int)ctx->presets.size()) {
        MessageBoxW(dlg, L"请选择导出预设。", L"MMDEncoder", MB_OK | MB_ICONWARNING);
        return TRUE;
      }
      ctx->presetId = ctx->presets[i].id;
      ctx->followMmd = IsDlgButtonChecked(dlg, IDC_FOLLOW) == BST_CHECKED;
      int f = (int)SendDlgItemMessageW(dlg, IDC_FADE, CB_GETCURSEL, 0, 0);
      ctx->audioFade = kFades[f < 0 ? 0 : f];
      int m = (int)SendDlgItemMessageW(dlg, IDC_MASK, CB_GETCURSEL, 0, 0);
      ctx->maskMode = m < 0 ? 0 : m;
    }
    EndDialog(dlg, LOWORD(wp) == IDOK);
    return TRUE;
  }
  return FALSE;
}

static void showSettings(HWND parent) {
  const std::wstring dir = pluginDir();
  std::string raw;
  Json config, selection;
  if (!readFile(dir + L"\\mmd-export.json", raw) || !JsonReader(raw).parse(config) ||
      config[L"version"].n != 2) {
    MessageBoxW(parent,
                L"还没有导出设置。\n\n请打开 MMDEncoder（1.4.0 或更新版本），在“MMD 导出”里安装或更新 MMD "
                L"导出插件；之后就能在这里选择导出预设。",
                L"MMDEncoder", MB_OK | MB_ICONINFORMATION);
    return;
  }
  SettingsContext ctx;
  for (const Json& p : config[L"presets"].a)
    if (p[L"unsupported"].s.empty()) {
      const Json& s = p[L"settings"];
      int mask = s[L"alphaMode"].s == L"mask"                               ? 2
                 : s[L"alphaMask"].type == Json::Bool && s[L"alphaMask"].b ? 1
                                                                            : 0;  // kMaskModes
      ctx.presets.push_back({p[L"id"].s, p[L"name"].s, mask});
    }
  raw.clear();
  if (readFile(dir + L"\\mmd-selection.json", raw) && JsonReader(raw).parse(selection)) {
    ctx.presetId = selection[L"presetId"].s;
    ctx.followMmd = selection[L"followMmd"].type != Json::Bool || selection[L"followMmd"].b;
    ctx.audioFade = selection[L"audioFade"].n;
    for (int i = 0; i < 3; i++)
      if (selection[L"maskMode"].s == utf16(kMaskModes[i])) ctx.maskMode = i;
    // Saved by 1.4.1, which only had the "also export the mask" switch.
    if (ctx.maskMode < 0 && selection[L"alphaMask"].type == Json::Bool && selection[L"alphaMask"].b)
      ctx.maskMode = 1;
  }
  ctx.appExe = config[L"appExe"].s;

  DialogTemplate t(L"MMDEncoder 导出设置", 270, 148);
  const WORD STATIC_ = 0x0082, BUTTON_ = 0x0080, COMBO_ = 0x0085;
  t.control(0xFFFF, STATIC_, SS_LEFT, 10, 8, 250, 9, L"导出预设");
  t.control(IDC_PRESET, COMBO_, CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, 10, 19, 250, 160, L"");
  t.control(IDC_FOLLOW, BUTTON_, BS_AUTOCHECKBOX | WS_TABSTOP, 10, 38, 250, 11,
            L"分辨率和帧率跟随 MMD（用这里设定的尺寸和帧率）");
  t.control(0xFFFF, STATIC_, SS_LEFT, 10, 54, 120, 9, L"Alpha 遮罩（同名 _alpha 黑白视频）");
  t.control(IDC_MASK, COMBO_, CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, 10, 65, 120, 80, L"");
  t.control(0xFFFF, STATIC_, SS_LEFT, 140, 54, 120, 9, L"音频淡入淡出");
  t.control(IDC_FADE, COMBO_, CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, 140, 65, 120, 80, L"");
  t.control(0xFFFF, STATIC_, SS_LEFT, 10, 88, 250, 34,
            L"成片保存在 AVI 同目录、同名，自动合成音频，完成后删除占位 AVI。"
            L"遮罩选项优先于预设自带的遮罩设置。这里的选择与 MMDEncoder 的“MMD 导出”同步，以最后保存的为准。");
  t.control(IDC_OPEN_APP, BUTTON_, BS_PUSHBUTTON | WS_TABSTOP, 10, 126, 80, 15, L"打开 MMDEncoder");
  t.control(IDOK, BUTTON_, BS_DEFPUSHBUTTON | WS_TABSTOP, 148, 126, 54, 15, L"确定");
  t.control(IDCANCEL, BUTTON_, BS_PUSHBUTTON | WS_TABSTOP, 206, 126, 54, 15, L"取消");
  if (DialogBoxIndirectParamW(g_module, t.get(), parent, settingsProc, (LPARAM)&ctx) != 1) return;

  SYSTEMTIME st;
  GetSystemTime(&st);
  char saved[40], fade[16];
  sprintf_s(saved, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute,
            st.wSecond, st.wMilliseconds);
  sprintf_s(fade, "%g", ctx.audioFade);
  std::string json = "{\n  \"presetId\": " + jsonString(ctx.presetId) + ",\n  \"followMmd\": " +
                     (ctx.followMmd ? "true" : "false") + ",\n  \"maskMode\": \"" + kMaskModes[ctx.maskMode] +
                     "\",\n  \"alphaMask\": " + (ctx.maskMode == 1 ? "true" : "false") +
                     ",\n  \"audioFade\": " + fade +
                     ",\n  \"savedAt\": \"" + saved + "\"\n}\n";
  std::wstring file = dir + L"\\mmd-selection.json", tmp = file + L".tmp";
  HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
  DWORD written = 0;
  bool ok = h != INVALID_HANDLE_VALUE && WriteFile(h, json.data(), (DWORD)json.size(), &written, nullptr);
  if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
  if (!ok || !MoveFileExW(tmp.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING))
    MessageBoxW(parent, L"无法保存导出设置。", L"MMDEncoder", MB_OK | MB_ICONWARNING);
}

static bool readFile(const std::wstring& path, std::string& out) {
  HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                         OPEN_EXISTING, 0, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size{};
  GetFileSizeEx(f, &size);
  out.resize((size_t)std::min<LONGLONG>(size.QuadPart, 64LL << 20));
  DWORD read = 0;
  ReadFile(f, out.data(), (DWORD)out.size(), &read, nullptr);
  out.resize(read);
  CloseHandle(f);
  return true;
}

// ----------------------------------------------------------- processes ---

// Quote one argument the way CommandLineToArgvW / the MSVC runtime parse it.
static std::wstring quoteArg(const std::wstring& a) {
  if (!a.empty() && a.find_first_of(L" \t\"") == std::wstring::npos) return a;
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (wchar_t c : a) {
    if (c == L'\\') {
      slashes++;
    } else if (c == L'"') {
      out.append(slashes * 2 + 1, L'\\');
      out += c;
      slashes = 0;
      continue;
    } else {
      slashes = 0;
    }
    out += c;
  }
  out.append(slashes, L'\\');
  return out + L"\"";
}

// Current environment plus a few variables, as a CREATE_UNICODE_ENVIRONMENT block.
static std::vector<wchar_t> environmentWith(const std::vector<std::pair<std::wstring, std::wstring>>& add) {
  std::vector<wchar_t> block;
  LPWCH env = GetEnvironmentStringsW();
  for (LPWCH p = env; *p; p += wcslen(p) + 1) {
    std::wstring entry = p;
    bool replaced = false;
    for (auto& kv : add)
      if (_wcsnicmp(entry.c_str(), (kv.first + L"=").c_str(), kv.first.size() + 1) == 0)
        replaced = true;
    if (!replaced) block.insert(block.end(), entry.begin(), entry.end() + 1);
  }
  FreeEnvironmentStringsW(env);
  for (auto& kv : add) {
    std::wstring entry = kv.first + L"=" + kv.second;
    block.insert(block.end(), entry.begin(), entry.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

// Run MMDEncoder.exe in Node mode with the helper script; returns its stdout.
static bool runHelper(const std::wstring& exe, const std::wstring& helper, const std::wstring& mode,
                      const std::string& job, std::string& out, DWORD timeoutMs) {
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE readPipe = nullptr, writePipe = nullptr;
  if (!CreatePipe(&readPipe, &writePipe, &sa, 0)) return false;
  SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);
  STARTUPINFOW si{sizeof(si)};
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = writePipe;
  si.hStdError = writePipe;
  si.hStdInput = nullptr;
  PROCESS_INFORMATION pi{};
  std::wstring cmd = quoteArg(exe) + L" " + quoteArg(helper);
  auto env = environmentWith({{L"ELECTRON_RUN_AS_NODE", L"1"},
                              {L"MMD_EXPORT_MODE", mode},
                              {L"MMD_EXPORT_JOB", utf16(job)}});
  BOOL ok = CreateProcessW(exe.c_str(), cmd.data(), nullptr, nullptr, TRUE,
                           CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, env.data(), nullptr, &si, &pi);
  CloseHandle(writePipe);
  if (!ok) {
    plog(L"cannot start helper %s (error %lu)", exe.c_str(), GetLastError());
    CloseHandle(readPipe);
    return false;
  }
  char buf[4096];
  DWORD n = 0;
  ULONGLONG deadline = GetTickCount64() + timeoutMs;
  while (ReadFile(readPipe, buf, sizeof(buf), &n, nullptr) && n) {
    out.append(buf, n);
    if (GetTickCount64() > deadline) break;
  }
  CloseHandle(readPipe);
  if (WaitForSingleObject(pi.hProcess, timeoutMs) == WAIT_TIMEOUT) TerminateProcess(pi.hProcess, 1);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return true;
}

// Start the finish step in the background; it must outlive nothing but runs
// after MMD releases the AVI, so it is detached from MMD's console and job.
static bool startDetached(const std::wstring& exe, const std::wstring& helper, const std::string& job) {
  STARTUPINFOW si{sizeof(si)};
  PROCESS_INFORMATION pi{};
  std::wstring cmd = quoteArg(exe) + L" " + quoteArg(helper);
  auto env = environmentWith(
      {{L"ELECTRON_RUN_AS_NODE", L"1"}, {L"MMD_EXPORT_MODE", L"finish"}, {L"MMD_EXPORT_JOB", utf16(job)}});
  for (DWORD extra : {(DWORD)CREATE_BREAKAWAY_FROM_JOB, (DWORD)0}) {
    if (CreateProcessW(exe.c_str(), cmd.data(), nullptr, nullptr, FALSE,
                       DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | extra,
                       env.data(), nullptr, &si, &pi)) {
      CloseHandle(pi.hThread);
      CloseHandle(pi.hProcess);
      return true;
    }
  }
  plog(L"cannot start finish step (error %lu)", GetLastError());
  return false;
}

// ---------------------------------------------------- reading from MMD ---

typedef struct {
  PVOID Object;
  ULONG_PTR UniqueProcessId;
  ULONG_PTR HandleValue;
  ULONG GrantedAccess;
  USHORT CreatorBackTraceIndex;
  USHORT ObjectTypeIndex;
  ULONG HandleAttributes;
  ULONG Reserved;
} HandleEntry;
typedef struct {
  ULONG_PTR NumberOfHandles;
  ULONG_PTR Reserved;
  HandleEntry Handles[1];
} HandleTable;
typedef NTSTATUS(NTAPI* QuerySystemInformation)(ULONG, PVOID, ULONG, PULONG);

// The AVI MMD is writing: the newest .avi file this process has open.
static std::wstring currentAvi() {
  auto query = reinterpret_cast<QuerySystemInformation>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySystemInformation"));
  if (!query) return L"";
  std::vector<unsigned char> buf(1 << 20);
  NTSTATUS status = 0;
  for (int i = 0; i < 8; i++) {
    ULONG need = 0;
    status = query(64 /* SystemExtendedHandleInformation */, buf.data(), (ULONG)buf.size(), &need);
    if (status != (NTSTATUS)0xC0000004L) break;
    buf.resize(std::max<size_t>(buf.size() * 2, need + 65536));
  }
  if (status < 0) return L"";
  auto* table = reinterpret_cast<HandleTable*>(buf.data());
  std::wstring best;
  ULONGLONG bestTime = 0;
  for (ULONG_PTR i = 0; i < table->NumberOfHandles; i++) {
    const HandleEntry& e = table->Handles[i];
    if (e.UniqueProcessId != GetCurrentProcessId()) continue;
    HANDLE h = reinterpret_cast<HANDLE>(e.HandleValue);
    if (GetFileType(h) != FILE_TYPE_DISK) continue;  // pipes could block below
    wchar_t path[1024];
    DWORD n = GetFinalPathNameByHandleW(h, path, 1023, FILE_NAME_NORMALIZED);
    if (!n || n >= 1023) continue;
    std::wstring p(path, n);
    if (p.size() < 4 || _wcsicmp(p.c_str() + p.size() - 4, L".avi") != 0) continue;
    if (p.rfind(L"\\\\?\\UNC\\", 0) == 0) p = L"\\\\" + p.substr(8);
    else if (p.rfind(L"\\\\?\\", 0) == 0) p = p.substr(4);
    FILETIME created{}, a{}, w{};
    GetFileTime(h, &created, &a, &w);
    ULONGLONG t = (ULONGLONG)created.dwHighDateTime << 32 | created.dwLowDateTime;
    if (best.empty() || t > bestTime) best = p, bestTime = t;
  }
  return best;
}

struct MmdState {
  long startFrame = -1, endFrame = -1;
  std::wstring pmm;
};

// While rendering, MMD shows a "RecWindow" titled like " 300フレーム録画中(500フレームまで)"
// (the Japanese text may be garbled; the numbers are what matter) and keeps the
// project path in its (hidden) main window title "MikuMikuDance [<path>.pmm]".
static MmdState readMmdState() {
  MmdState st;
  EnumWindows(
      [](HWND hwnd, LPARAM param) -> BOOL {
        DWORD pid = 0;
        GetWindowThreadProcessId(hwnd, &pid);
        if (pid != GetCurrentProcessId()) return TRUE;
        auto* st = reinterpret_cast<MmdState*>(param);
        wchar_t cls[64] = {0}, title[1024] = {0};
        GetClassNameW(hwnd, cls, 63);
        InternalGetWindowText(hwnd, title, 1023);  // no message, safe from any thread
        std::wstring t = title;
        if (wcscmp(cls, L"RecWindow") == 0) {
          std::vector<long> numbers;
          for (size_t i = 0; i < t.size();) {
            if (iswdigit(t[i])) {
              size_t j = i;
              while (j < t.size() && iswdigit(t[j])) j++;
              numbers.push_back(std::stol(t.substr(i, j - i)));
              i = j;
            } else {
              i++;
            }
          }
          if (numbers.size() >= 2) st->startFrame = numbers[0], st->endFrame = numbers[1];
        }
        size_t open = t.find(L'['), close = t.rfind(L']');
        if (open != std::wstring::npos && close != std::wstring::npos && close > open) {
          std::wstring p = t.substr(open + 1, close - open - 1);
          if (p.size() > 4 && _wcsicmp(p.c_str() + p.size() - 4, L".pmm") == 0) st->pmm = p;
        }
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&st));
  return st;
}

// --------------------------------------------------------- media types ---

static bool readVideoInfo(const DMO_MEDIA_TYPE* mt, VIDEOINFOHEADER* out) {
  if (!mt || mt->majortype != MEDIATYPE_Video || mt->formattype != FORMAT_VideoInfo ||
      mt->cbFormat < sizeof(VIDEOINFOHEADER) || !mt->pbFormat)
    return false;
  *out = *reinterpret_cast<const VIDEOINFOHEADER*>(mt->pbFormat);
  return true;
}

// ARGB32 first: MMD offers it before RGB32, and it carries the transparency.
static const GUID* kInputs[] = {&MEDIASUBTYPE_ARGB32, &MEDIASUBTYPE_RGB32, &MEDIASUBTYPE_RGB24};

static bool acceptableInput(const DMO_MEDIA_TYPE* mt) {
  VIDEOINFOHEADER vih{};
  if (!readVideoInfo(mt, &vih)) return false;
  bool known = false;
  for (auto* g : kInputs) known |= mt->subtype == *g;
  const auto& b = vih.bmiHeader;
  return known && b.biCompression == BI_RGB && (b.biBitCount == 24 || b.biBitCount == 32) &&
         b.biWidth > 0 && b.biHeight != 0 && vih.AvgTimePerFrame > 0;
}

// ------------------------------------------------------------- the DMO ---

// COM aggregation: DirectShow's DMO Wrapper (used by MMD) creates the DMO
// aggregated inside itself; refusing aggregation makes MMD fall back to raw AVI.
class Encoder : public IMediaObject, public IAMVfwCompressDialogs {
 public:
  explicit Encoder(IUnknown* outer) : inner_(this), outer_(outer ? outer : &inner_) {
    g_objects++;
  }
  ~Encoder() {
    finish();
    if (haveIn_) MoFreeMediaType(&in_);
    if (haveOut_) MoFreeMediaType(&out_);
    g_objects--;
  }
  IUnknown* inner() { return &inner_; }

  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override { return outer_->QueryInterface(riid, ppv); }
  STDMETHODIMP_(ULONG) AddRef() override { return outer_->AddRef(); }
  STDMETHODIMP_(ULONG) Release() override { return outer_->Release(); }

  // IAMVfwCompressDialogs: MMD's codec "settings" button.
  STDMETHODIMP ShowDialog(int dialog, HWND parent) override {
    if (dialog == VfwCompressDialog_QueryConfig || dialog == VfwCompressDialog_QueryAbout) return S_OK;
    if (dialog == VfwCompressDialog_Config || dialog == VfwCompressDialog_About) {
      showSettings(parent);
      return S_OK;
    }
    return E_INVALIDARG;
  }
  STDMETHODIMP GetState(LPVOID, int*) override { return E_NOTIMPL; }
  STDMETHODIMP SetState(LPVOID, int) override { return E_NOTIMPL; }
  STDMETHODIMP SendDriverMessage(int, long, long) override { return E_NOTIMPL; }

  // IMediaObject
  STDMETHODIMP GetStreamCount(DWORD* in, DWORD* out) override {
    if (!in || !out) return E_POINTER;
    *in = *out = 1;
    return S_OK;
  }
  STDMETHODIMP GetInputStreamInfo(DWORD s, DWORD* flags) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    if (!flags) return E_POINTER;
    *flags = DMO_INPUT_STREAMF_WHOLE_SAMPLES | DMO_INPUT_STREAMF_SINGLE_SAMPLE_PER_BUFFER;
    return S_OK;
  }
  STDMETHODIMP GetOutputStreamInfo(DWORD s, DWORD* flags) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    if (!flags) return E_POINTER;
    *flags = DMO_OUTPUT_STREAMF_WHOLE_SAMPLES | DMO_OUTPUT_STREAMF_SINGLE_SAMPLE_PER_BUFFER;
    return S_OK;
  }
  STDMETHODIMP GetInputType(DWORD s, DWORD index, DMO_MEDIA_TYPE* mt) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    if (index >= _countof(kInputs)) return DMO_E_NO_MORE_ITEMS;
    if (!mt) return S_OK;
    HRESULT hr = MoInitMediaType(mt, 0);
    if (FAILED(hr)) return hr;
    mt->majortype = MEDIATYPE_Video;
    mt->subtype = *kInputs[index];
    mt->formattype = GUID_NULL;
    return S_OK;
  }
  STDMETHODIMP GetOutputType(DWORD s, DWORD index, DMO_MEDIA_TYPE* mt) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    if (!haveIn_) return DMO_E_TYPE_NOT_SET;
    if (index > 0) return DMO_E_NO_MORE_ITEMS;
    if (!mt) return S_OK;
    HRESULT hr = MoInitMediaType(mt, sizeof(VIDEOINFOHEADER));
    if (FAILED(hr)) return hr;
    mt->majortype = MEDIATYPE_Video;
    mt->subtype = MEDIASUBTYPE_MMDE;
    mt->formattype = FORMAT_VideoInfo;
    auto* v = reinterpret_cast<VIDEOINFOHEADER*>(mt->pbFormat);
    ZeroMemory(v, sizeof(*v));
    v->AvgTimePerFrame = inInfo_.AvgTimePerFrame;
    v->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    v->bmiHeader.biWidth = inInfo_.bmiHeader.biWidth;
    v->bmiHeader.biHeight = std::abs(inInfo_.bmiHeader.biHeight);
    v->bmiHeader.biPlanes = 1;
    v->bmiHeader.biBitCount = 24;
    v->bmiHeader.biCompression = kFourcc;
    v->bmiHeader.biSizeImage = kPlaceholderBytes;
    return S_OK;
  }
  STDMETHODIMP SetInputType(DWORD s, const DMO_MEDIA_TYPE* mt, DWORD flags) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    if (flags & DMO_SET_TYPEF_CLEAR) {
      if (haveIn_) MoFreeMediaType(&in_);
      haveIn_ = false;
      return S_OK;
    }
    if (!mt) return E_POINTER;
    if (!acceptableInput(mt)) return DMO_E_TYPE_NOT_ACCEPTED;
    if (flags & DMO_SET_TYPEF_TEST_ONLY) return S_OK;
    if (haveIn_) MoFreeMediaType(&in_);
    MoCopyMediaType(&in_, mt);
    haveIn_ = true;
    readVideoInfo(&in_, &inInfo_);
    return S_OK;
  }
  STDMETHODIMP SetOutputType(DWORD s, const DMO_MEDIA_TYPE* mt, DWORD flags) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    if (flags & DMO_SET_TYPEF_CLEAR) {
      if (haveOut_) MoFreeMediaType(&out_);
      haveOut_ = false;
      return S_OK;
    }
    if (!mt) return E_POINTER;
    if (!haveIn_) return DMO_E_TYPE_NOT_SET;
    if (mt->majortype != MEDIATYPE_Video || mt->subtype != MEDIASUBTYPE_MMDE) return DMO_E_TYPE_NOT_ACCEPTED;
    if (flags & DMO_SET_TYPEF_TEST_ONLY) return S_OK;
    if (haveOut_) MoFreeMediaType(&out_);
    MoCopyMediaType(&out_, mt);
    haveOut_ = true;
    return S_OK;
  }
  STDMETHODIMP GetInputCurrentType(DWORD s, DMO_MEDIA_TYPE* mt) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    if (!haveIn_) return DMO_E_TYPE_NOT_SET;
    return mt ? MoCopyMediaType(mt, &in_) : E_POINTER;
  }
  STDMETHODIMP GetOutputCurrentType(DWORD s, DMO_MEDIA_TYPE* mt) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    if (!haveOut_) return DMO_E_TYPE_NOT_SET;
    return mt ? MoCopyMediaType(mt, &out_) : E_POINTER;
  }
  STDMETHODIMP GetInputSizeInfo(DWORD s, DWORD* size, DWORD* lookahead, DWORD* align) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    if (!haveIn_) return DMO_E_TYPE_NOT_SET;
    if (!size || !lookahead || !align) return E_POINTER;
    *size = stride() * (DWORD)std::abs(inInfo_.bmiHeader.biHeight);
    *lookahead = 0;
    *align = 1;
    return S_OK;
  }
  STDMETHODIMP GetOutputSizeInfo(DWORD s, DWORD* size, DWORD* align) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    if (!size || !align) return E_POINTER;
    *size = kPlaceholderBytes;
    *align = 1;
    return S_OK;
  }
  STDMETHODIMP GetInputMaxLatency(DWORD, REFERENCE_TIME* latency) override {
    if (!latency) return E_POINTER;
    *latency = 0;
    return S_OK;
  }
  STDMETHODIMP SetInputMaxLatency(DWORD, REFERENCE_TIME) override { return E_NOTIMPL; }
  STDMETHODIMP Flush() override {
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    pending_ = false;
    return S_OK;
  }
  STDMETHODIMP Discontinuity(DWORD s) override { return s ? DMO_E_INVALIDSTREAMINDEX : S_OK; }
  STDMETHODIMP AllocateStreamingResources() override {
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    frames_ = 0;
    waited_ = longestWait_ = 0;
    failed_ = false;
    finished_ = false;
    error_.clear();
    return S_OK;
  }
  // MMD calls this when the render ends (or is cancelled).
  STDMETHODIMP FreeStreamingResources() override {
    finish();
    return S_OK;
  }
  STDMETHODIMP GetInputStatus(DWORD s, DWORD* flags) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    if (!flags) return E_POINTER;
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    *flags = pending_ ? 0 : DMO_INPUT_STATUSF_ACCEPT_DATA;
    return S_OK;
  }
  STDMETHODIMP ProcessInput(DWORD s, IMediaBuffer* buffer, DWORD flags, REFERENCE_TIME time,
                            REFERENCE_TIME length) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    if (!buffer) return E_POINTER;
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    if (!haveIn_) return DMO_E_TYPE_NOT_SET;
    if (pending_) return DMO_E_NOTACCEPTING;
    BYTE* data = nullptr;
    DWORD bytes = 0;
    buffer->GetBufferAndLength(&data, &bytes);
    if (frames_ == 0) {
      const double t = seconds();
      start();
      setup_ = seconds() - t;
      renderStart_ = seconds();
    }
    if (encoder_ && !failed_) {
      // Time MMD spends blocked here is time it waits for FFmpeg.
      const double t = seconds();
      writeFrame(data, bytes);
      const double w = seconds() - t;
      waited_ += w;
      if (w > longestWait_) longestWait_ = w;
    }
    pendingFlags_ = flags;
    pendingTime_ = time;
    pendingLength_ = length;
    pending_ = true;
    frames_++;
    return S_OK;
  }
  STDMETHODIMP ProcessOutput(DWORD, DWORD count, DMO_OUTPUT_DATA_BUFFER* out, DWORD* status) override {
    if (!out || !status || count != 1) return E_INVALIDARG;
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    *status = 0;
    out[0].dwStatus = 0;
    if (!pending_) return S_FALSE;
    if (!out[0].pBuffer) {
      pending_ = false;
      return S_OK;
    }
    BYTE* data = nullptr;
    DWORD max = 0;
    out[0].pBuffer->GetMaxLength(&max);
    out[0].pBuffer->GetBufferAndLength(&data, nullptr);
    if (max < kPlaceholderBytes || !data) return E_FAIL;
    // Placeholder sample "MMDE" + frame index: finish only deletes AVIs made of these.
    memset(data, 0, kPlaceholderBytes);
    memcpy(data, "MMDE", 4);
    uint64_t index = frames_ - 1;
    memcpy(data + 4, &index, sizeof(index));
    out[0].pBuffer->SetLength(kPlaceholderBytes);
    out[0].dwStatus = DMO_OUTPUT_DATA_BUFFERF_SYNCPOINT;
    if (pendingFlags_ & DMO_INPUT_DATA_BUFFERF_TIME) {
      out[0].dwStatus |= DMO_OUTPUT_DATA_BUFFERF_TIME;
      out[0].rtTimestamp = pendingTime_;
    }
    if (pendingFlags_ & DMO_INPUT_DATA_BUFFERF_TIMELENGTH) {
      out[0].dwStatus |= DMO_OUTPUT_DATA_BUFFERF_TIMELENGTH;
      out[0].rtTimelength = pendingLength_;
    }
    pending_ = false;
    return S_OK;
  }
  STDMETHODIMP Lock(LONG) override { return S_OK; }

 private:
  DWORD stride() const {
    const auto& b = inInfo_.bmiHeader;
    return ((DWORD)b.biWidth * b.biBitCount / 8 + 3) & ~3u;
  }

  void fail(const std::wstring& message) {
    if (!failed_) plog(L"FAILED: %s", message.c_str());
    failed_ = true;
    if (error_.empty()) error_ = message;
  }

  // First frame: work out where and how to encode, then start FFmpeg.
  void start() {
    const auto& b = inInfo_.bmiHeader;
    width_ = b.biWidth;
    height_ = std::abs(b.biHeight);
    bits_ = b.biBitCount;
    avi_ = currentAvi();
    mmd_ = readMmdState();
    wchar_t exe[MAX_PATH] = {0};
    GetModuleFileNameW(nullptr, exe, MAX_PATH);
    plog(L"render start in %s: %ldx%ld %d-bit %s, AvgTimePerFrame=%lld, frames %ld-%ld, avi=%s, pmm=%s",
         exe, width_, height_, bits_, b.biHeight > 0 ? L"bottom-up" : L"top-down", inInfo_.AvgTimePerFrame,
         mmd_.startFrame, mmd_.endFrame, avi_.c_str(), mmd_.pmm.c_str());
    if (avi_.empty()) return fail(L"找不到 MMD 正在写入的 AVI 文件");
    std::string raw;
    if (!readFile(pluginDir() + L"\\mmd-export.json", raw) || !JsonReader(raw).parse(config_))
      return fail(L"还没有选择导出预设：请在 MMDEncoder 的“预设管理”里选择 MMD 导出预设");
    appExe_ = config_[L"appExe"].s;
    helper_ = config_[L"helper"].s;
    if (appExe_.empty() || helper_.empty()) return fail(L"导出设置不完整，请在 MMDEncoder 里重新选择导出预设");

    // pmm and startFrame let a cut-off export be finished later (mmd-export recover()).
    char head[512];
    sprintf_s(head, ",\"width\":%ld,\"height\":%ld,\"bits\":%d,\"bottomUp\":%s,\"avgTimePerFrame\":%lld,\"startFrame\":%ld}",
              width_, height_, bits_, b.biHeight > 0 ? "true" : "false", inInfo_.AvgTimePerFrame, mmd_.startFrame);
    const std::string job = "{\"avi\":" + jsonString(avi_) + ",\"pmm\":" + jsonString(mmd_.pmm) + head;
    std::string reply;
    Json plan;
    if (!runHelper(appExe_, helper_, L"plan", job, reply, 30000) || !JsonReader(reply).parse(plan))
      return fail(L"MMDEncoder 没有返回导出命令：" + utf16(reply.substr(0, 400)));
    if (!plan[L"ok"].b) return fail(L"无法使用当前导出预设：" + plan[L"error"].s);
    temp_ = plan[L"temp"].s;
    output_ = plan[L"output"].s;
    std::wstring ffmpeg = plan[L"exe"].s;
    std::wstring cmd = quoteArg(ffmpeg);
    for (const Json& a : plan[L"args"].a) cmd += L" " + quoteArg(a.s);
    plog(L"output %s (preset %s)", output_.c_str(), plan[L"presetName"].s.c_str());
    if (!plan[L"maskOutput"].s.empty()) plog(L"alpha mask %s", plan[L"maskOutput"].s.c_str());
    for (const Json& n : plan[L"notes"].a) plog(L"note: %s", n.s.c_str());
    plog(L"ffmpeg: %s", cmd.c_str());

    // FFmpeg reads frames from stdin; its messages go to a log next to ours.
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    HANDLE readPipe = nullptr;
    if (!CreatePipe(&readPipe, &stdin_, &sa, 4 << 20)) return fail(L"无法创建管道");
    SetHandleInformation(stdin_, HANDLE_FLAG_INHERIT, 0);
    std::wstring ffLog = Log::get().path();
    ffLog = ffLog.substr(0, ffLog.size() - 4) + L"-ffmpeg.log";
    HANDLE err = CreateFileW(ffLog.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, &sa, OPEN_ALWAYS,
                             FILE_ATTRIBUTE_NORMAL, nullptr);
    HANDLE nul = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
    STARTUPINFOW si{sizeof(si)};
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = readPipe;
    si.hStdOutput = nul;
    si.hStdError = err;
    PROCESS_INFORMATION pi{};
    BOOL ok = CreateProcessW(ffmpeg.c_str(), cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                             nullptr, &si, &pi);
    CloseHandle(readPipe);
    if (err != INVALID_HANDLE_VALUE) CloseHandle(err);
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    if (!ok) {
      CloseHandle(stdin_);
      stdin_ = nullptr;
      return fail(L"无法启动 FFmpeg：" + ffmpeg);
    }
    CloseHandle(pi.hThread);
    encoder_ = pi.hProcess;
    row_.resize((size_t)width_ * bits_ / 8);
  }

  void writeFrame(const BYTE* data, DWORD bytes) {
    const DWORD rowBytes = (DWORD)row_.size(), srcStride = stride();
    if (!data || bytes < srcStride * (DWORD)height_) return fail(L"MMD 送来的画面大小不对");
    auto write = [&](const BYTE* p, DWORD n) {
      while (n) {
        DWORD done = 0;
        if (!WriteFile(stdin_, p, n, &done, nullptr) || !done) return false;
        p += done;
        n -= done;
      }
      return true;
    };
    bool ok = srcStride == rowBytes ? write(data, rowBytes * (DWORD)height_) : true;
    if (srcStride != rowBytes)  // 24-bit rows are padded to 4 bytes; FFmpeg wants them packed
      for (long y = 0; ok && y < height_; y++) ok = write(data + (size_t)y * srcStride, rowBytes);
    if (!ok) fail(L"FFmpeg 提前退出，详见 FFmpeg 日志");
  }

  // End of render: let FFmpeg finish, then hand over to the finish step.
  void finish() {
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    if (finished_ || frames_ == 0) return;
    finished_ = true;
    const double lastFrame = seconds();
    if (stdin_) CloseHandle(stdin_), stdin_ = nullptr;
    DWORD code = 1;
    if (encoder_) {
      if (WaitForSingleObject(encoder_, 30 * 60 * 1000) == WAIT_TIMEOUT) {
        TerminateProcess(encoder_, 1);
        fail(L"FFmpeg 超过 30 分钟未结束，已停止");
      }
      GetExitCodeProcess(encoder_, &code);
      CloseHandle(encoder_);
      encoder_ = nullptr;
      if (code != 0) fail(L"FFmpeg 编码失败（退出码 " + std::to_wstring(code) + L"），详见 FFmpeg 日志");
    }
    plog(L"render end: %llu frames, ffmpeg exit %lu", frames_, code);
    // Whether a frame queue would help: share of the render MMD sat waiting
    // for FFmpeg to take a frame, and how long FFmpeg ran on after the last one.
    const double render = lastFrame - renderStart_;
    plog(L"timing: setup %.2f s, render %.2f s (%.1f fps), waiting for FFmpeg %.2f s (%.1f%%, longest %.0f ms), "
         L"FFmpeg finished %.2f s after the last frame",
         setup_, render, render > 0 ? frames_ / render : 0.0, waited_, render > 0 ? 100 * waited_ / render : 0.0,
         1000 * longestWait_, seconds() - lastFrame);
    if (!failed_) {
      // The same timing, for MMDEncoder to show with the export.
      char head[512];
      sprintf_s(head,
                ",\"frames\":%llu,\"avgTimePerFrame\":%lld,\"startFrame\":%ld,\"timing\":{\"setup\":%.3f,"
                "\"render\":%.3f,\"waited\":%.3f,\"longestWait\":%.3f,\"encoderTail\":%.3f}}",
                frames_, inInfo_.AvgTimePerFrame, mmd_.startFrame, setup_, render, waited_, longestWait_,
                seconds() - lastFrame);
      std::string job = "{\"avi\":" + jsonString(avi_) + ",\"temp\":" + jsonString(temp_) +
                        ",\"output\":" + jsonString(output_) + ",\"pmm\":" + jsonString(mmd_.pmm) + head;
      if (startDetached(appExe_, helper_, job)) {
        plog(L"finish step started for %s", output_.c_str());
        return;
      }
      fail(L"无法启动收尾步骤（合成音频、删除占位 AVI）");
    }
    std::wstring text = L"MMDEncoder 导出失败：\n" + error_ + L"\n\n日志：" + Log::get().path();
    MessageBoxW(nullptr, text.c_str(), L"MMDEncoder", MB_OK | MB_ICONWARNING | MB_TOPMOST);
  }

  class Inner : public IUnknown {
   public:
    explicit Inner(Encoder* owner) : owner_(owner) {}
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
      if (!ppv) return E_POINTER;
      *ppv = nullptr;
      if (riid == IID_IUnknown) *ppv = static_cast<IUnknown*>(this);
      else if (riid == IID_IMediaObject) *ppv = static_cast<IMediaObject*>(owner_);
      else if (riid == IID_IAMVfwCompressDialogs) *ppv = static_cast<IAMVfwCompressDialogs*>(owner_);
      else return E_NOINTERFACE;
      static_cast<IUnknown*>(*ppv)->AddRef();
      return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
    STDMETHODIMP_(ULONG) Release() override {
      ULONG n = --refs_;
      if (!n) delete owner_;
      return n;
    }

   private:
    Encoder* owner_;
    std::atomic<ULONG> refs_{1};
  };

  Inner inner_;
  IUnknown* outer_;
  std::recursive_mutex mutex_;
  DMO_MEDIA_TYPE in_{}, out_{};
  VIDEOINFOHEADER inInfo_{};
  bool haveIn_ = false, haveOut_ = false, pending_ = false, failed_ = false, finished_ = false;
  DWORD pendingFlags_ = 0;
  REFERENCE_TIME pendingTime_ = 0, pendingLength_ = 0;
  unsigned long long frames_ = 0;
  double setup_ = 0, renderStart_ = 0, waited_ = 0, longestWait_ = 0;  // seconds
  long width_ = 0, height_ = 0;
  int bits_ = 0;
  MmdState mmd_;
  Json config_;
  std::wstring avi_, temp_, output_, appExe_, helper_, error_;
  HANDLE stdin_ = nullptr, encoder_ = nullptr;
  std::vector<BYTE> row_;
};

// ------------------------------------------------------- class factory ---

class Factory : public IClassFactory {
 public:
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IClassFactory) {
      *ppv = static_cast<IClassFactory*>(this);
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return 2; }
  STDMETHODIMP_(ULONG) Release() override { return 1; }
  STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (outer && riid != IID_IUnknown) return CLASS_E_NOAGGREGATION;
    auto* p = new (std::nothrow) Encoder(outer);
    if (!p) return E_OUTOFMEMORY;
    HRESULT hr = p->inner()->QueryInterface(riid, ppv);
    p->inner()->Release();
    return hr;
  }
  STDMETHODIMP LockServer(BOOL lock) override {
    lock ? g_locks++ : g_locks--;
    return S_OK;
  }
};
static Factory g_factory;

// ------------------------------------------------------------- exports ---

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void** ppv) {
  if (clsid != CLSID_MMDEncoderPlugin) return CLASS_E_CLASSNOTAVAILABLE;
  return g_factory.QueryInterface(riid, ppv);
}

STDAPI DllCanUnloadNow() { return g_objects == 0 && g_locks == 0 ? S_OK : S_FALSE; }

static LONG setValue(const std::wstring& key, const wchar_t* name, DWORD type, const void* data, DWORD size) {
  HKEY k;
  LONG r = RegCreateKeyExW(HKEY_CURRENT_USER, key.c_str(), 0, nullptr, 0, KEY_WRITE, nullptr, &k, nullptr);
  if (r) return r;
  r = RegSetValueExW(k, name, 0, type, (const BYTE*)data, size);
  RegCloseKey(k);
  return r;
}
static LONG setString(const std::wstring& key, const wchar_t* name, const std::wstring& value) {
  return setValue(key, name, REG_SZ, value.c_str(), (DWORD)((value.size() + 1) * sizeof(wchar_t)));
}

static std::wstring classKey() { return std::wstring(L"Software\\Classes\\CLSID\\") + kClsidText; }
static std::wstring dmoKey() { return std::wstring(L"Software\\Classes\\DirectShow\\MediaObjects\\") + kClsidBare; }
static std::wstring categoryKey() {
  return std::wstring(L"Software\\Classes\\DirectShow\\MediaObjects\\Categories\\") + kCategoryBare + L"\\" +
         kClsidBare;
}

// Per-user registration (HKCU): no administrator rights needed.
// One line per (un)registration in logs\install.log, next to the lines the app
// writes: which process registered which DLL. The registry was twice found
// pointing back to an older, deleted build; this shows who wrote it.
static void journal(const char* event) {
  wchar_t dll[MAX_PATH] = L"", host[MAX_PATH] = L"";
  GetModuleFileNameW(g_module, dll, MAX_PATH);
  GetModuleFileNameW(nullptr, host, MAX_PATH);
  std::wstring parent;
  // regsvr32 itself says little; its parent process tells who ran it.
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap != INVALID_HANDLE_VALUE) {
    PROCESSENTRY32W pe{sizeof(pe)};
    DWORD self = GetCurrentProcessId(), parentId = 0;
    for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe))
      if (pe.th32ProcessID == self) parentId = pe.th32ParentProcessID;
    for (BOOL ok = Process32FirstW(snap, &pe); parentId && ok; ok = Process32NextW(snap, &pe))
      if (pe.th32ProcessID == parentId) parent = pe.szExeFile;
    CloseHandle(snap);
  }
  SYSTEMTIME st;
  GetSystemTime(&st);
  char at[40];
  sprintf_s(at, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute,
            st.wSecond, st.wMilliseconds);
  std::string line = std::string("{\"at\":\"") + at + "\",\"event\":\"" + event + "\",\"dll\":" + jsonString(dll) +
                     ",\"host\":" + jsonString(host) + ",\"parent\":" + jsonString(parent) +
                     ",\"pid\":" + std::to_string(GetCurrentProcessId()) + "}\n";
  std::wstring dir = pluginDir() + L"\\logs";
  CreateDirectoryW(dir.c_str(), nullptr);
  HANDLE h = CreateFileW((dir + L"\\install.log").c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(h, line.data(), (DWORD)line.size(), &written, nullptr);
  CloseHandle(h);
}

STDAPI DllRegisterServer() {
  journal("dll-register");
  wchar_t path[MAX_PATH];
  GetModuleFileNameW(g_module, path, MAX_PATH);
  std::vector<GUID> inputs;
  for (auto* g : kInputs) inputs.push_back(MEDIATYPE_Video), inputs.push_back(*g);
  const GUID outputs[] = {MEDIATYPE_Video, MEDIASUBTYPE_MMDE};
  LONG r = setString(classKey(), nullptr, kName);
  if (!r) r = setString(classKey() + L"\\InprocServer32", nullptr, path);
  if (!r) r = setString(classKey() + L"\\InprocServer32", L"ThreadingModel", L"Both");
  if (!r) r = setString(dmoKey(), nullptr, kName);
  if (!r) r = setValue(dmoKey(), L"InputTypes", REG_BINARY, inputs.data(), (DWORD)(inputs.size() * sizeof(GUID)));
  if (!r) r = setValue(dmoKey(), L"OutputTypes", REG_BINARY, outputs, sizeof(outputs));
  if (!r) r = setString(categoryKey(), nullptr, L"");
  return r ? HRESULT_FROM_WIN32(r) : S_OK;
}

STDAPI DllUnregisterServer() {
  journal("dll-unregister");
  for (const std::wstring& key : {categoryKey(), dmoKey(), classKey()}) {
    RegDeleteTreeW(HKEY_CURRENT_USER, key.c_str());
    RegDeleteKeyW(HKEY_CURRENT_USER, key.c_str());
  }
  return S_OK;
}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = module;
    DisableThreadLibraryCalls(module);
  }
  return TRUE;
}
