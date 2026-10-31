#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "settings.h"
#include "json.h"
#include "messages.h"
#include "settings-layout.h"
#include "platform.h"
#include <algorithm>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <shellapi.h>
#include <vector>
#include <cerrno>
#include <cwchar>
#include <cwctype>
#include <cmath>

// ------------------------------------------------------ settings window ---
// MMD's "詳細設定" for this codec: the same choices as MMDEncoder's preset
// manager (preset, follow MMD's size and frame rate, alpha mask, audio fade). The choice is
// saved to mmd-selection.json, which MMDEncoder also reads and writes; MMDEncoder adopts a
// choice saved here as soon as it lands.

enum { IDC_PRESET = 101, IDC_FOLLOW = 102, IDC_FADE = 103, IDC_MASK = 104, IDC_OPEN_APP = 105, IDC_SUFFIX = 106, IDC_TEST = 107,
       IDC_SHIFT = 111, IDC_AUTO_SHIFT = 112, IDC_SHIFT_LABEL = 115 };
static constexpr long long kMaxShiftFrames = 9007199254740991LL;
static const double kFades[] = {0, 0.5, 1, 2};

// Alpha mask: the choice overrides the preset's own alpha setting.
static const char* kMaskModes[] = {"off", "with", "only"};
static const wchar_t* kMaskKeys[] = {L"plugin.maskOff", L"plugin.maskWith", L"plugin.maskOnly"};
static Json numberParam(const wchar_t* name, double value) { Json args; args.type=Json::Object; args.o[name].type=Json::Number; args.o[name].n=value; return args; }
static Json textParam(const wchar_t* name, const std::wstring& value) { Json args; args.type=Json::Object; args.o[name].type=Json::String; args.o[name].s=value; return args; }

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
  long long audioShiftFrames = 0;
  bool audioAutoShift = true;
  std::wstring appExe;  // MMDEncoder.exe, from mmd-export.json
  std::wstring helper;
  bool testing = false;
  ProcessLog log;
  PluginMessages messages;
};

static bool readAudioShift(HWND dlg, SettingsContext* ctx, long long& value) {
  HWND edit = GetDlgItem(dlg, IDC_SHIFT);
  std::wstring text(GetWindowTextLengthW(edit) + 1, 0);
  GetWindowTextW(edit, text.data(), (int)text.size());
  wchar_t* end = nullptr;
  errno = 0;
  value = std::wcstoll(text.c_str(), &end, 10);
  const bool converted = end != text.c_str();
  while (*end && std::iswspace(*end)) ++end;
  if (errno == ERANGE || !converted || *end || value < -kMaxShiftFrames || value > kMaxShiftFrames) {
    MessageBoxW(dlg, ctx->messages.text(L"error.MMD_AUDIO_SHIFT_INVALID").c_str(), L"MMDEncoder", MB_OK | MB_ICONWARNING);
    SetFocus(edit);
    SendMessageW(edit, EM_SETSEL, 0, -1);
    return false;
  }
  return true;
}

static bool readSettings(HWND dlg, SettingsContext* ctx) {
  int i = (int)SendDlgItemMessageW(dlg, IDC_PRESET, CB_GETCURSEL, 0, 0);
  if (i < 0 || i >= (int)ctx->presets.size()) {
    MessageBoxW(dlg, ctx->messages.text(L"plugin.presetRequired").c_str(), L"MMDEncoder", MB_OK | MB_ICONWARNING);
    return false;
  }
  ctx->presetId = ctx->presets[i].id;
  long long shift;
  if (!readAudioShift(dlg, ctx, shift)) return false;
  ctx->audioShiftFrames = shift;
  ctx->audioAutoShift = IsDlgButtonChecked(dlg, IDC_AUTO_SHIFT) == BST_CHECKED;
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
  DialogTemplate(const wchar_t* title, short w, short h, const wchar_t* font) {
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
    text(font);
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
    SetDlgItemTextW(dlg, IDC_SHIFT, std::to_wstring(ctx->audioShiftFrames).c_str());
    CheckDlgButton(dlg, IDC_AUTO_SHIFT, ctx->audioAutoShift ? BST_CHECKED : BST_UNCHECKED);
    HWND fade = GetDlgItem(dlg, IDC_FADE);
    int fadeIndex = 0;
    for (int i = 0; i < 4; i++) {
      SendMessageW(fade, CB_ADDSTRING, 0, (LPARAM)(i ? ctx->messages.format(L"plugin.fadeSeconds", numberParam(L"seconds", kFades[i])) : ctx->messages.text(L"plugin.fadeOff")).c_str());
      if (kFades[i] == ctx->audioFade) fadeIndex = i;
    }
    SendMessageW(fade, CB_SETCURSEL, fadeIndex, 0);
    HWND mask = GetDlgItem(dlg, IDC_MASK);
    for (int i = 0; i < 3; i++) SendMessageW(mask, CB_ADDSTRING, 0, (LPARAM)ctx->messages.text(kMaskKeys[i]).c_str());
    SendMessageW(mask, CB_SETCURSEL, ctx->maskMode, 0);
    EnableWindow(GetDlgItem(dlg, IDC_TEST), selected >= 0);
    fitSettingsLayout(dlg, {ctx->messages.format(L"plugin.testPassedShort", numberParam(L"seconds", 99.9)),
      ctx->messages.text(L"plugin.test"), ctx->messages.text(L"plugin.testing"), ctx->messages.text(L"plugin.testFailedShort")});
    return TRUE;
  }
  if (ctx && ctx->testing && (msg == WM_CLOSE || msg == WM_COMMAND)) return TRUE;
  // A result belongs to the choices it tested: changing them resets the button.
  // EDIT can notify while the template is created, before WM_INITDIALOG.
  if (ctx && msg == WM_COMMAND &&
      ((HIWORD(wp) == CBN_SELCHANGE &&
        (LOWORD(wp) == IDC_PRESET || LOWORD(wp) == IDC_MASK || LOWORD(wp) == IDC_FADE)) ||
       (HIWORD(wp) == BN_CLICKED && (LOWORD(wp) == IDC_FOLLOW || LOWORD(wp) == IDC_AUTO_SHIFT)) ||
       (HIWORD(wp) == EN_CHANGE && LOWORD(wp) == IDC_SHIFT)))
    SetDlgItemTextW(dlg, IDC_TEST, ctx->messages.text(L"plugin.test").c_str());
  if (msg == WM_COMMAND && LOWORD(wp) == IDC_TEST && HIWORD(wp) == BN_CLICKED) {
    if (!readSettings(dlg, ctx)) return TRUE;
    char fade[16];
    sprintf_s(fade, "%g", ctx->audioFade);
    // Test exactly the choices shown here without saving them; Cancel keeps
    // the last saved selection, even after a successful or failed test.
    std::string job = "{\"selection\":{\"presetId\":" + jsonString(ctx->presetId) +
                      ",\"followMmd\":" + (ctx->followMmd ? "true" : "false") +
                      ",\"rangeSuffix\":" + (ctx->rangeSuffix ? "true" : "false") +
                      ",\"audioShiftFrames\":" + std::to_string(ctx->audioShiftFrames) +
                      ",\"audioAutoShift\":" + (ctx->audioAutoShift ? "true" : "false") +
                      ",\"maskMode\":\"" + kMaskModes[ctx->maskMode] +
                      "\",\"audioFade\":" + fade + "}}";
    ctx->testing = true;
    const int controls[] = {IDC_PRESET, IDC_FOLLOW, IDC_SUFFIX, IDC_FADE, IDC_MASK, IDC_SHIFT, IDC_AUTO_SHIFT, IDC_OPEN_APP, IDC_TEST, IDOK, IDCANCEL};
    for (int id : controls) EnableWindow(GetDlgItem(dlg, id), FALSE);
    SetDlgItemTextW(dlg, IDC_TEST, ctx->messages.text(L"plugin.testing").c_str());
    const ULONGLONG started = GetTickCount64();
    std::string reply;
    Json result;
    bool answered = runHelper(ctx->appExe, ctx->helper, L"test", job, reply, 75000, ctx->log, dlg) &&
                    JsonReader(reply).parse(result);
    ctx->testing = false;
    for (int id : controls) EnableWindow(GetDlgItem(dlg, id), TRUE);
    const bool ok = answered && result[L"ok"].b;
    std::wstring message = ok ? ctx->messages.result(result, L"message.", result[L"message"].s)
        : ctx->messages.format(L"plugin.testFailure", textParam(L"detail", answered ? ctx->messages.result(result[L"errorData"], L"error.", result[L"error"].s) : ctx->messages.text(L"plugin.noTestResult")));
    // The result in brief on the button itself (no message box); the whole
    // message, with a failure's reason, goes to the plugin log.
    ctx->log(L"encoding test: %s", message.c_str());
    std::wstring brief = ok ? ctx->messages.format(L"plugin.testPassedShort", numberParam(L"seconds", (GetTickCount64() - started) / 1000.0)) : ctx->messages.text(L"plugin.testFailedShort");
    SetDlgItemTextW(dlg, IDC_TEST, brief.c_str());
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
      MessageBoxW(dlg, ctx->messages.text(L"plugin.appMissing").c_str(),
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
  SettingsContext ctx;
  ctx.log = log;
  std::string raw;
  Json config, selection;
  if (!readFile(dir + L"\\mmd-export.json", raw) || !JsonReader(raw).parse(config) ||
      config[L"version"].n != 2) {
    MessageBoxW(parent,
                ctx.messages.text(L"plugin.configMissing").c_str(),
                L"MMDEncoder", MB_OK | MB_ICONINFORMATION);
    return;
  }
  ctx.messages = PluginMessages(config);
  for (const Json& p : config[L"presets"].a)
    if (p[L"unsupported"].s.empty()) {
      ctx.presets.push_back({p[L"id"].s, p[L"displayName"].s.empty() ? p[L"name"].s : p[L"displayName"].s});
    }
  raw.clear();
  if (readFile(dir + L"\\mmd-selection.json", raw) && JsonReader(raw).parse(selection)) {
    ctx.presetId = selection[L"presetId"].s;
    ctx.followMmd = selection[L"followMmd"].type != Json::Bool || selection[L"followMmd"].b;
    ctx.rangeSuffix = selection[L"rangeSuffix"].type != Json::Bool || selection[L"rangeSuffix"].b;
    ctx.audioFade = selection[L"audioFade"].n;
    const Json& shift = selection[L"audioShiftFrames"];
    if (shift.type == Json::Number && std::isfinite(shift.n) && std::floor(shift.n) == shift.n &&
        shift.n >= -kMaxShiftFrames && shift.n <= kMaxShiftFrames) ctx.audioShiftFrames = (long long)shift.n;
    ctx.audioAutoShift = selection[L"audioAutoShift"].type != Json::Bool || selection[L"audioAutoShift"].b;
    for (int i = 0; i < 3; i++)
      if (selection[L"maskMode"].s == utf16(kMaskModes[i])) ctx.maskMode = i;
  }
  ctx.appExe = config[L"appExe"].s;
  ctx.helper = config[L"helper"].s;

  DialogTemplate t(ctx.messages.text(L"plugin.title").c_str(), 270, 188, ctx.messages.font());
  const WORD STATIC_ = 0x0082, BUTTON_ = 0x0080, COMBO_ = 0x0085, EDIT_ = 0x0081;
  t.control(0xFFFF, STATIC_, SS_LEFT, 10, 8, 250, 9, ctx.messages.text(L"plugin.preset").c_str());
  t.control(IDC_PRESET, COMBO_, CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, 10, 19, 250, 160, L"");
  t.control(IDC_FOLLOW, BUTTON_, BS_AUTOCHECKBOX | WS_TABSTOP, 10, 38, 250, 11,
            ctx.messages.text(L"plugin.follow").c_str());
  t.control(IDC_SUFFIX, BUTTON_, BS_AUTOCHECKBOX | WS_TABSTOP, 10, 52, 250, 11,
            ctx.messages.text(L"plugin.suffix").c_str());
  t.control(109, STATIC_, SS_LEFT, 10, 68, 120, 9, ctx.messages.text(L"plugin.mask").c_str());
  t.control(IDC_MASK, COMBO_, CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, 10, 79, 120, 80, L"");
  t.control(110, STATIC_, SS_LEFT, 140, 68, 120, 9, ctx.messages.text(L"plugin.fade").c_str());
  t.control(IDC_FADE, COMBO_, CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, 140, 79, 120, 80, L"");
  t.control(IDC_SHIFT_LABEL, STATIC_, SS_LEFT, 10, 102, 120, 9, ctx.messages.text(L"plugin.audioShift").c_str());
  t.control(IDC_SHIFT, EDIT_, WS_BORDER | ES_AUTOHSCROLL | WS_TABSTOP, 10, 113, 120, 15, L"0");
  t.control(IDC_AUTO_SHIFT, BUTTON_, BS_AUTOCHECKBOX | WS_TABSTOP, 140, 113, 120, 15, ctx.messages.text(L"plugin.audioAutoShift").c_str());
  t.control(108, STATIC_, SS_LEFT, 10, 136, 250, 22,
            ctx.messages.text(L"plugin.note").c_str());
  t.control(IDC_OPEN_APP, BUTTON_, BS_PUSHBUTTON | WS_TABSTOP, 10, 166, 80, 15, ctx.messages.text(L"plugin.openApp").c_str());
  t.control(IDC_TEST, BUTTON_, BS_PUSHBUTTON | WS_TABSTOP, 94, 166, 50, 15, ctx.messages.text(L"plugin.test").c_str());
  t.control(IDOK, BUTTON_, BS_DEFPUSHBUTTON | WS_TABSTOP, 148, 166, 54, 15, ctx.messages.text(L"plugin.ok").c_str());
  t.control(IDCANCEL, BUTTON_, BS_PUSHBUTTON | WS_TABSTOP, 206, 166, 54, 15, ctx.messages.text(L"plugin.cancel").c_str());
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
                     ",\n  \"audioShiftFrames\": " + std::to_string(ctx.audioShiftFrames) +
                     ",\n  \"audioAutoShift\": " + (ctx.audioAutoShift ? "true" : "false") +
                     ",\n  \"savedAt\": \"" + saved + "\"\n}\n";
  std::wstring file = dir + L"\\mmd-selection.json", tmp = file + L".tmp";
  HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
  DWORD written = 0;
  bool ok = h != INVALID_HANDLE_VALUE && WriteFile(h, json.data(), (DWORD)json.size(), &written, nullptr);
  if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
  if (!ok || !MoveFileExW(tmp.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING))
    MessageBoxW(parent, ctx.messages.text(L"plugin.saveFailed").c_str(), L"MMDEncoder", MB_OK | MB_ICONWARNING);
}

