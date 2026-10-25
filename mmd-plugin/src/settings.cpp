#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "settings.h"
#include "json.h"
#include "platform.h"
#include <algorithm>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <shellapi.h>
#include <vector>

// ------------------------------------------------------ settings window ---
// MMD's "詳細設定" for this codec: the same choices as MMDEncoder's preset
// manager (preset, follow MMD's size and frame rate, alpha mask, audio fade). The choice is
// saved to mmd-selection.json, which MMDEncoder also reads and writes; MMDEncoder adopts a
// choice saved here as soon as it lands.

enum { IDC_PRESET = 101, IDC_FOLLOW = 102, IDC_FADE = 103, IDC_MASK = 104, IDC_OPEN_APP = 105, IDC_SUFFIX = 106, IDC_TEST = 107 };
static const double kFades[] = {0, 0.5, 1, 2};
static const wchar_t* kFadeNames[] = {L"关闭", L"0.5 秒", L"1 秒", L"2 秒"};
// Alpha mask: the choice overrides the preset's own alpha setting.
static const char* kMaskModes[] = {"off", "with", "only"};
static const wchar_t* kMaskNames[] = {L"不导出", L"同时导出遮罩", L"仅导出遮罩"};

struct SettingsContext {
  struct Preset {
    std::wstring id, name;
  };
  std::vector<Preset> presets;
  std::wstring presetId;
  bool followMmd = true;
  bool rangeSuffix = true;  // name the file with the MMD frame range (_0400-0600f)
  int maskMode = 0;
  double audioFade = 0;
  std::wstring appExe;  // MMDEncoder.exe, from mmd-export.json
  std::wstring helper;
  bool testing = false;
  ProcessLog log;
};

static bool readSettings(HWND dlg, SettingsContext* ctx) {
  int i = (int)SendDlgItemMessageW(dlg, IDC_PRESET, CB_GETCURSEL, 0, 0);
  if (i < 0 || i >= (int)ctx->presets.size()) {
    MessageBoxW(dlg, L"请选择导出预设。", L"MMDEncoder", MB_OK | MB_ICONWARNING);
    return false;
  }
  ctx->presetId = ctx->presets[i].id;
  ctx->followMmd = IsDlgButtonChecked(dlg, IDC_FOLLOW) == BST_CHECKED;
  ctx->rangeSuffix = IsDlgButtonChecked(dlg, IDC_SUFFIX) == BST_CHECKED;
  int f = (int)SendDlgItemMessageW(dlg, IDC_FADE, CB_GETCURSEL, 0, 0);
  ctx->audioFade = kFades[f < 0 ? 0 : f];
  int m = (int)SendDlgItemMessageW(dlg, IDC_MASK, CB_GETCURSEL, 0, 0);
  ctx->maskMode = m < 0 ? 0 : m;
  return true;
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
    // Nothing chosen yet (or the choice is gone): the editing intermediate.
    for (size_t i = 0; selected < 0 && i < ctx->presets.size(); i++)
      if (ctx->presets[i].id == L"builtin-prores422") {
        selected = (int)i;
        ctx->presetId = ctx->presets[i].id;
      }
    SendMessageW(presets, CB_SETCURSEL, selected, 0);
    CheckDlgButton(dlg, IDC_FOLLOW, ctx->followMmd ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(dlg, IDC_SUFFIX, ctx->rangeSuffix ? BST_CHECKED : BST_UNCHECKED);
    HWND fade = GetDlgItem(dlg, IDC_FADE);
    int fadeIndex = 0;
    for (int i = 0; i < 4; i++) {
      SendMessageW(fade, CB_ADDSTRING, 0, (LPARAM)kFadeNames[i]);
      if (kFades[i] == ctx->audioFade) fadeIndex = i;
    }
    SendMessageW(fade, CB_SETCURSEL, fadeIndex, 0);
    HWND mask = GetDlgItem(dlg, IDC_MASK);
    for (int i = 0; i < 3; i++) SendMessageW(mask, CB_ADDSTRING, 0, (LPARAM)kMaskNames[i]);
    SendMessageW(mask, CB_SETCURSEL, ctx->maskMode, 0);
    EnableWindow(GetDlgItem(dlg, IDC_TEST), selected >= 0);
    return TRUE;
  }
  if (ctx && ctx->testing && (msg == WM_CLOSE || msg == WM_COMMAND)) return TRUE;
  // A result belongs to the choices it tested: changing them resets the button.
  if (msg == WM_COMMAND &&
      ((HIWORD(wp) == CBN_SELCHANGE &&
        (LOWORD(wp) == IDC_PRESET || LOWORD(wp) == IDC_MASK || LOWORD(wp) == IDC_FADE)) ||
       (HIWORD(wp) == BN_CLICKED && LOWORD(wp) == IDC_FOLLOW)))
    SetDlgItemTextW(dlg, IDC_TEST, L"编码测试");
  if (msg == WM_COMMAND && LOWORD(wp) == IDC_TEST && HIWORD(wp) == BN_CLICKED) {
    if (!readSettings(dlg, ctx)) return TRUE;
    char fade[16];
    sprintf_s(fade, "%g", ctx->audioFade);
    // Test exactly the choices shown here without saving them; Cancel keeps
    // the last saved selection, even after a successful or failed test.
    std::string job = "{\"selection\":{\"presetId\":" + jsonString(ctx->presetId) +
                      ",\"followMmd\":" + (ctx->followMmd ? "true" : "false") +
                      ",\"maskMode\":\"" + kMaskModes[ctx->maskMode] +
                      "\",\"audioFade\":" + fade + "}}";
    ctx->testing = true;
    const int controls[] = {IDC_PRESET, IDC_FOLLOW, IDC_SUFFIX, IDC_FADE, IDC_MASK, IDC_OPEN_APP, IDC_TEST, IDOK, IDCANCEL};
    for (int id : controls) EnableWindow(GetDlgItem(dlg, id), FALSE);
    SetDlgItemTextW(dlg, IDC_TEST, L"测试中…");
    const ULONGLONG started = GetTickCount64();
    std::string reply;
    Json result;
    bool answered = runHelper(ctx->appExe, ctx->helper, L"test", job, reply, 75000, ctx->log, dlg) &&
                    JsonReader(reply).parse(result);
    ctx->testing = false;
    for (int id : controls) EnableWindow(GetDlgItem(dlg, id), TRUE);
    const bool ok = answered && result[L"ok"].b;
    std::wstring message = ok ? result[L"message"].s
                            : L"编码测试失败：" + (answered ? result[L"error"].s : L"MMDEncoder 没有返回测试结果，请检查程序和编码引擎是否可用。");
    // The result in brief on the button itself (no message box); the whole
    // message, with a failure's reason, goes to the plugin log.
    ctx->log(L"encoding test: %s", message.c_str());
    wchar_t brief[32];
    if (ok)
      swprintf_s(brief, L"\x2713 %.1f 秒", (GetTickCount64() - started) / 1000.0);
    else
      wcscpy_s(brief, L"\x2717 失败");
    SetDlgItemTextW(dlg, IDC_TEST, brief);
    SetFocus(GetDlgItem(dlg, IDC_TEST));
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
    EnableWindow(GetDlgItem(dlg, IDC_TEST), SendDlgItemMessageW(dlg, IDC_PRESET, CB_GETCURSEL, 0, 0) >= 0);
    return TRUE;
  }
  if (msg == WM_COMMAND && (LOWORD(wp) == IDOK || LOWORD(wp) == IDCANCEL)) {
    if (LOWORD(wp) == IDOK) {
      if (!readSettings(dlg, ctx)) return TRUE;
    }
    EndDialog(dlg, LOWORD(wp) == IDOK);
    return TRUE;
  }
  return FALSE;
}

void showSettings(HWND parent, HINSTANCE module, const std::wstring& dir, ProcessLog log) {
  std::string raw;
  Json config, selection;
  if (!readFile(dir + L"\\mmd-export.json", raw) || !JsonReader(raw).parse(config) ||
      config[L"version"].n != 2) {
    MessageBoxW(parent,
                L"还没有导出设置。\n\n请打开 MMDEncoder，在“MMD 导出”里安装或更新 MMD "
                L"导出插件；之后就能在这里选择导出预设。",
                L"MMDEncoder", MB_OK | MB_ICONINFORMATION);
    return;
  }
  SettingsContext ctx;
  ctx.log = log;
  for (const Json& p : config[L"presets"].a)
    if (p[L"unsupported"].s.empty()) {
      ctx.presets.push_back({p[L"id"].s, p[L"name"].s});
    }
  raw.clear();
  if (readFile(dir + L"\\mmd-selection.json", raw) && JsonReader(raw).parse(selection)) {
    ctx.presetId = selection[L"presetId"].s;
    ctx.followMmd = selection[L"followMmd"].type != Json::Bool || selection[L"followMmd"].b;
    ctx.rangeSuffix = selection[L"rangeSuffix"].type != Json::Bool || selection[L"rangeSuffix"].b;
    ctx.audioFade = selection[L"audioFade"].n;
    for (int i = 0; i < 3; i++)
      if (selection[L"maskMode"].s == utf16(kMaskModes[i])) ctx.maskMode = i;
  }
  ctx.appExe = config[L"appExe"].s;
  ctx.helper = config[L"helper"].s;

  DialogTemplate t(L"MMDEncoder 导出设置", 270, 150);
  const WORD STATIC_ = 0x0082, BUTTON_ = 0x0080, COMBO_ = 0x0085;
  t.control(0xFFFF, STATIC_, SS_LEFT, 10, 8, 250, 9, L"导出预设");
  t.control(IDC_PRESET, COMBO_, CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, 10, 19, 250, 160, L"");
  t.control(IDC_FOLLOW, BUTTON_, BS_AUTOCHECKBOX | WS_TABSTOP, 10, 38, 250, 11,
            L"分辨率和帧率跟随 MMD");
  t.control(IDC_SUFFIX, BUTTON_, BS_AUTOCHECKBOX | WS_TABSTOP, 10, 52, 250, 11,
            L"文件名加 MMD 帧范围");
  t.control(0xFFFF, STATIC_, SS_LEFT, 10, 68, 120, 9, L"Alpha 遮罩");
  t.control(IDC_MASK, COMBO_, CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, 10, 79, 120, 80, L"");
  t.control(0xFFFF, STATIC_, SS_LEFT, 140, 68, 120, 9, L"音频淡入淡出");
  t.control(IDC_FADE, COMBO_, CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, 140, 79, 120, 80, L"");
  t.control(0xFFFF, STATIC_, SS_LEFT, 10, 102, 250, 18,
            L"自动合成音频，完成后删除占位 AVI。此处选项优先级高于 MMDEncoder 预设本身。");
  t.control(IDC_OPEN_APP, BUTTON_, BS_PUSHBUTTON | WS_TABSTOP, 10, 128, 80, 15, L"打开 MMDEncoder");
  t.control(IDC_TEST, BUTTON_, BS_PUSHBUTTON | WS_TABSTOP, 94, 128, 50, 15, L"编码测试");
  t.control(IDOK, BUTTON_, BS_DEFPUSHBUTTON | WS_TABSTOP, 148, 128, 54, 15, L"确定");
  t.control(IDCANCEL, BUTTON_, BS_PUSHBUTTON | WS_TABSTOP, 206, 128, 54, 15, L"取消");
  if (DialogBoxIndirectParamW(module, t.get(), parent, settingsProc, (LPARAM)&ctx) != 1) return;

  SYSTEMTIME st;
  GetSystemTime(&st);
  char saved[40], fade[16];
  sprintf_s(saved, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute,
            st.wSecond, st.wMilliseconds);
  sprintf_s(fade, "%g", ctx.audioFade);
  std::string json = "{\n  \"presetId\": " + jsonString(ctx.presetId) + ",\n  \"followMmd\": " +
                     (ctx.followMmd ? "true" : "false") + ",\n  \"maskMode\": \"" + kMaskModes[ctx.maskMode] +
                     "\",\n  \"rangeSuffix\": " + (ctx.rangeSuffix ? "true" : "false") +
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

