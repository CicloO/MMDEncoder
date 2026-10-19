// MMDEncoder MMD export plugin - EXPERIMENTAL PROBE.
//
// A DMO video encoder that MMD lists under "AVI output > video codec". This probe
// does not encode anything: it records what MMD hands an encoder and what can be
// read from MMD's process, so the real plugin can be designed on facts. It returns
// a tiny placeholder sample per frame so the AVI MMD writes stays small.
//
// Log: %LOCALAPPDATA%\MMDEncoder\mmd-plugin\logs\probe-<time>-<pid>.log
// Registration is per user (HKCU), done by DllRegisterServer via regsvr32.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cguid.h>
#include <knownfolders.h>
#include <mediaobj.h>
#include <dmo.h>
#include <uuids.h>
#include <amvideo.h>
#include <strmif.h>
#include <shlobj.h>
#include <winternl.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
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

// {DC2177DF-7421-4112-B1C1-EA4AB130EE8B}
static const GUID CLSID_MMDEncoderProbe = {
    0xdc2177df, 0x7421, 0x4112, {0xb1, 0xc1, 0xea, 0x4a, 0xb1, 0x30, 0xee, 0x8b}};
static const wchar_t* kClsidText = L"{DC2177DF-7421-4112-B1C1-EA4AB130EE8B}";
static const wchar_t* kClsidBare = L"DC2177DF-7421-4112-B1C1-EA4AB130EE8B";
static const wchar_t* kName = L"MMDEncoder (Probe)";
// Video compressor category (= DMOCATEGORY_VIDEO_ENCODER).
static const wchar_t* kCategoryBare = L"33d9a760-90c8-11d0-bd43-00a0c911ce86";
// Placeholder output subtype: FOURCC 'MMDE'.
static const DWORD kFourcc = MAKEFOURCC('M', 'M', 'D', 'E');
static const GUID MEDIASUBTYPE_MMDE = {
    kFourcc, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
static const DWORD kPlaceholderBytes = 16;

static HMODULE g_module = nullptr;
static std::atomic<long> g_objects{0};
static std::atomic<long> g_locks{0};

// ---------------------------------------------------------------- logging ---

static std::wstring utf16(const std::string& s, UINT cp) {
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

static std::wstring logDir() {
  PWSTR base = nullptr;
  std::wstring dir;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &base))) {
    dir = std::wstring(base) + L"\\MMDEncoder\\mmd-plugin\\logs";
    CoTaskMemFree(base);
  } else {
    wchar_t tmp[MAX_PATH];
    GetTempPathW(MAX_PATH, tmp);
    dir = std::wstring(tmp) + L"MMDEncoder-mmd-plugin";
  }
  SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
  return dir;
}

class Log {
 public:
  static Log& get() {
    static Log log;
    return log;
  }
  void line(const std::wstring& text) {
    std::lock_guard<std::mutex> lock(mutex_);
    open();
    if (file_ == INVALID_HANDLE_VALUE) return;
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::steady_clock::now() - start_)
                  .count();
    wchar_t head[64];
    swprintf_s(head, L"[%8.3f t%-5lu] ", ms / 1000.0, GetCurrentThreadId());
    std::string bytes = utf8(head + text) + "\r\n";
    DWORD written = 0;
    WriteFile(file_, bytes.data(), (DWORD)bytes.size(), &written, nullptr);
  }
  std::wstring dir() {
    std::lock_guard<std::mutex> lock(mutex_);
    open();
    return dir_;
  }

 private:
  void open() {
    if (opened_) return;
    opened_ = true;
    dir_ = logDir();
    SYSTEMTIME st;
    GetLocalTime(&st);
    wchar_t name[96];
    swprintf_s(name, L"\\probe-%04d%02d%02d-%02d%02d%02d-%lu.log", st.wYear, st.wMonth, st.wDay,
               st.wHour, st.wMinute, st.wSecond, GetCurrentProcessId());
    file_ = CreateFileW((dir_ + name).c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                        OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file_ != INVALID_HANDLE_VALUE) {
      DWORD written = 0;
      WriteFile(file_, "\xEF\xBB\xBF", 3, &written, nullptr);
    }
  }
  std::mutex mutex_;
  bool opened_ = false;
  HANDLE file_ = INVALID_HANDLE_VALUE;
  std::wstring dir_;
  std::chrono::steady_clock::time_point start_ = std::chrono::steady_clock::now();
};

static void plog(const wchar_t* fmt, ...) {
  wchar_t buf[2048];
  va_list args;
  va_start(args, fmt);
  _vsnwprintf_s(buf, _TRUNCATE, fmt, args);
  va_end(args);
  Log::get().line(buf);
}

static std::wstring guidText(const GUID& g) {
  wchar_t s[64];
  StringFromGUID2(g, s, 64);
  return s;
}

// ----------------------------------------------------------- MMD probing ---

// Text of a window that may belong to another (possibly busy) thread of MMD:
// never block, so a stuck UI thread cannot deadlock the encoder thread.
static std::wstring windowText(HWND hwnd) {
  wchar_t buf[512] = {0};
  DWORD_PTR result = 0;
  if (!SendMessageTimeoutW(hwnd, WM_GETTEXT, 511, (LPARAM)buf, SMTO_ABORTIFHUNG | SMTO_BLOCK, 150,
                           &result))
    return L"<no reply>";
  return buf;
}

struct WindowDump {
  std::wstring tag;
  int windows = 0;
};

static BOOL CALLBACK dumpChild(HWND hwnd, LPARAM param) {
  auto* dump = reinterpret_cast<WindowDump*>(param);
  wchar_t cls[128] = {0};
  GetClassNameW(hwnd, cls, 127);
  std::wstring text = windowText(hwnd);
  std::wstring extra;
  if (_wcsicmp(cls, L"Button") == 0) {
    DWORD_PTR state = 0;
    if (SendMessageTimeoutW(hwnd, BM_GETCHECK, 0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 150, &state))
      extra = state == BST_CHECKED ? L" [checked]" : L"";
  }
  if (text.size() > 200) text = text.substr(0, 200) + L"…";
  plog(L"  %s   child id=%d class=%s visible=%d text=\"%s\"%s", dump->tag.c_str(),
       GetDlgCtrlID(hwnd), cls, IsWindowVisible(hwnd) ? 1 : 0, text.c_str(), extra.c_str());
  return TRUE;
}

static BOOL CALLBACK dumpTop(HWND hwnd, LPARAM param) {
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid != GetCurrentProcessId()) return TRUE;
  auto* dump = reinterpret_cast<WindowDump*>(param);
  wchar_t cls[128] = {0}, title[512] = {0};
  GetClassNameW(hwnd, cls, 127);
  InternalGetWindowText(hwnd, title, 511);  // no message, safe from any thread
  RECT r{};
  GetWindowRect(hwnd, &r);
  plog(L"  %s top hwnd=%p class=%s visible=%d rect=%ld,%ld %ldx%ld title=\"%s\"",
       dump->tag.c_str(), hwnd, cls, IsWindowVisible(hwnd) ? 1 : 0, r.left, r.top,
       r.right - r.left, r.bottom - r.top, title);
  dump->windows++;
  if (IsWindowVisible(hwnd)) EnumChildWindows(hwnd, dumpChild, param);
  return TRUE;
}

static void dumpWindows(const wchar_t* when) {
  plog(L"== MMD windows (%s)", when);
  WindowDump dump{when};
  EnumWindows(dumpTop, reinterpret_cast<LPARAM>(&dump));
  plog(L"== %d top-level windows", dump.windows);
}

// Files MMD currently has open whose name ends in .avi (the output it writes).
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

static std::vector<std::wstring> openAviFiles() {
  std::vector<std::wstring> found;
  auto query = reinterpret_cast<QuerySystemInformation>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySystemInformation"));
  if (!query) return found;
  std::vector<unsigned char> buf(1 << 20);
  NTSTATUS status;
  for (int i = 0; i < 8; i++) {
    ULONG need = 0;
    status = query(64 /* SystemExtendedHandleInformation */, buf.data(), (ULONG)buf.size(), &need);
    if (status != (NTSTATUS)0xC0000004L) break;  // STATUS_INFO_LENGTH_MISMATCH
    buf.resize(std::max<size_t>(buf.size() * 2, need + 65536));
  }
  if (status < 0) return found;
  auto* table = reinterpret_cast<HandleTable*>(buf.data());
  const ULONG_PTR self = GetCurrentProcessId();
  for (ULONG_PTR i = 0; i < table->NumberOfHandles; i++) {
    const HandleEntry& e = table->Handles[i];
    if (e.UniqueProcessId != self) continue;
    HANDLE h = reinterpret_cast<HANDLE>(e.HandleValue);
    if (GetFileType(h) != FILE_TYPE_DISK) continue;  // pipes could block below
    wchar_t path[1024];
    DWORD n = GetFinalPathNameByHandleW(h, path, 1023, FILE_NAME_NORMALIZED);
    if (!n || n >= 1023) continue;
    std::wstring p(path, n);
    if (p.size() > 4 && _wcsicmp(p.c_str() + p.size() - 4, L".avi") == 0) {
      if (p.rfind(L"\\\\?\\", 0) == 0) p = p.substr(4);
      if (std::find(found.begin(), found.end(), p) == found.end()) found.push_back(p);
    }
  }
  return found;
}

static void logAviFiles(const wchar_t* when) {
  auto files = openAviFiles();
  plog(L"== open .avi files (%s): %zu", when, files.size());
  for (auto& f : files) {
    WIN32_FILE_ATTRIBUTE_DATA a{};
    unsigned long long size = 0;
    if (GetFileAttributesExW(f.c_str(), GetFileExInfoStandard, &a))
      size = (unsigned long long)a.nFileSizeHigh << 32 | a.nFileSizeLow;
    plog(L"  %s (%llu bytes)", f.c_str(), size);
  }
}

// MMD shows the open project in its main window title; the .pmm stores the WAV
// path as a Shift-JIS string. Log every ".wav" string found in the file.
static void logProjectAudio() {
  struct Find {
    std::wstring pmm;
  } find;
  EnumWindows(
      [](HWND hwnd, LPARAM param) -> BOOL {
        DWORD pid = 0;
        GetWindowThreadProcessId(hwnd, &pid);
        // The main window is hidden while rendering, so hidden windows count too.
        if (pid != GetCurrentProcessId()) return TRUE;
        wchar_t title[1024] = {0};
        InternalGetWindowText(hwnd, title, 1023);
        std::wstring t = title, lower = t;
        for (auto& c : lower) c = (wchar_t)towlower(c);
        size_t end = lower.find(L".pmm");
        if (end == std::wstring::npos) return TRUE;
        end += 4;
        // Start at the last drive letter ("X:\") or UNC prefix before ".pmm".
        size_t start = std::wstring::npos;
        for (size_t i = 0; i + 2 < end; i++)
          if ((iswalpha(t[i]) && t[i + 1] == L':' && t[i + 2] == L'\\') ||
              (t[i] == L'\\' && t[i + 1] == L'\\'))
            start = i;
        if (start != std::wstring::npos)
          reinterpret_cast<Find*>(param)->pmm = t.substr(start, end - start);
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&find));
  plog(L"== project file from title: \"%s\"", find.pmm.c_str());
  if (find.pmm.empty()) return;
  HANDLE f = CreateFileW(find.pmm.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         nullptr, OPEN_EXISTING, 0, nullptr);
  if (f == INVALID_HANDLE_VALUE) {
    plog(L"  cannot open project file (error %lu)", GetLastError());
    return;
  }
  LARGE_INTEGER size{};
  GetFileSizeEx(f, &size);
  std::string data((size_t)std::min<LONGLONG>(size.QuadPart, 256LL << 20), '\0');
  DWORD read = 0;
  ReadFile(f, data.data(), (DWORD)data.size(), &read, nullptr);
  CloseHandle(f);
  data.resize(read);
  plog(L"  project size %lu bytes", read);
  int hits = 0;
  for (size_t pos = 0; (pos = data.find(".wav", pos)) != std::string::npos && hits < 20;
       pos += 4) {
    size_t s = pos;
    while (s > 0 && (unsigned char)data[s - 1] >= 0x20) s--;
    std::string raw = data.substr(s, pos + 4 - s);
    // Chinese MMD builds write GBK (936), Japanese ones Shift-JIS (932): keep the
    // decoding whose path exists.
    for (UINT cp : {936u, 932u}) {
      std::wstring path = utf16(raw, cp);
      bool exists = GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES;
      plog(L"  wav string at offset %zu (cp%u, %s): \"%s\"", s, cp,
           exists ? L"exists" : L"not found", path.c_str());
    }
    hits++;
  }
  if (!hits) plog(L"  no \".wav\" string in project file");
}

// --------------------------------------------------------- media types ---

static bool readVideoInfo(const DMO_MEDIA_TYPE* mt, VIDEOINFOHEADER* out) {
  if (!mt || mt->majortype != MEDIATYPE_Video || mt->formattype != FORMAT_VideoInfo ||
      mt->cbFormat < sizeof(VIDEOINFOHEADER) || !mt->pbFormat)
    return false;
  *out = *reinterpret_cast<const VIDEOINFOHEADER*>(mt->pbFormat);
  return true;
}

static void logType(const wchar_t* what, const DMO_MEDIA_TYPE* mt, DWORD flags) {
  VIDEOINFOHEADER vih{};
  const wchar_t* sub = mt->subtype == MEDIASUBTYPE_RGB24   ? L"RGB24"
                       : mt->subtype == MEDIASUBTYPE_RGB32 ? L"RGB32"
                       : mt->subtype == MEDIASUBTYPE_ARGB32 ? L"ARGB32"
                       : mt->subtype == MEDIASUBTYPE_MMDE  ? L"MMDE"
                                                           : L"other";
  if (readVideoInfo(mt, &vih)) {
    const auto& b = vih.bmiHeader;
    double fps = vih.AvgTimePerFrame ? 1e7 / (double)vih.AvgTimePerFrame : 0;
    plog(L"%s flags=0x%lx subtype=%s %s %ldx%ld bits=%u compression=0x%08lx sizeImage=%lu "
         L"AvgTimePerFrame=%lld (%.4f fps) %s",
         what, flags, sub, guidText(mt->subtype).c_str(), b.biWidth, b.biHeight, b.biBitCount,
         b.biCompression, b.biSizeImage, vih.AvgTimePerFrame, fps,
         b.biHeight > 0 ? L"bottom-up" : L"top-down");
  } else {
    plog(L"%s flags=0x%lx subtype=%s %s format=%s cb=%lu", what, flags, sub,
         guidText(mt->subtype).c_str(), guidText(mt->formattype).c_str(), mt->cbFormat);
  }
}

static bool acceptableInput(const DMO_MEDIA_TYPE* mt) {
  VIDEOINFOHEADER vih{};
  if (!readVideoInfo(mt, &vih)) return false;
  if (mt->subtype != MEDIASUBTYPE_RGB24 && mt->subtype != MEDIASUBTYPE_RGB32) return false;
  const auto& b = vih.bmiHeader;
  return b.biCompression == BI_RGB && (b.biBitCount == 24 || b.biBitCount == 32) &&
         b.biWidth > 0 && b.biHeight != 0;
}

// Logged lazily (not from DllMain) the first time an object is created.
struct LoadNote {
  LoadNote() {
    wchar_t exe[MAX_PATH] = {0}, dll[MAX_PATH] = {0};
    GetModuleFileNameW(nullptr, exe, MAX_PATH);
    GetModuleFileNameW(g_module, dll, MAX_PATH);
    plog(L"MMDEncoder probe loaded into %s (pid %lu) from %s", exe, GetCurrentProcessId(), dll);
  }
};

// ------------------------------------------------------------- the DMO ---

// COM aggregation: DirectShow's DMO Wrapper filter (what MMD's AVI output uses)
// creates the DMO *aggregated* inside itself, so the object must support an outer
// IUnknown. Refusing aggregation made the wrapper fail ("DirectShow unsupported").
class Probe : public IMediaObject, public IAMVfwCompressDialogs {
 public:
  explicit Probe(IUnknown* outer) : inner_(this), outer_(outer ? outer : &inner_) {
    static LoadNote note;
    g_objects++;
    id_ = ++counter_;
    plog(L"object #%ld created (%s)", id_, outer ? L"aggregated" : L"standalone");
  }
  ~Probe() {
    finish(L"object destroyed");
    if (haveIn_) MoFreeMediaType(&in_);
    if (haveOut_) MoFreeMediaType(&out_);
    plog(L"object #%ld destroyed", id_);
    g_objects--;
  }
  IUnknown* inner() { return &inner_; }

  // Delegating IUnknown (shared by IMediaObject and IAMVfwCompressDialogs).
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    return outer_->QueryInterface(riid, ppv);
  }
  STDMETHODIMP_(ULONG) AddRef() override { return outer_->AddRef(); }
  STDMETHODIMP_(ULONG) Release() override { return outer_->Release(); }

  // IAMVfwCompressDialogs: the codec's settings / about buttons in MMD.
  STDMETHODIMP ShowDialog(int dialog, HWND parent) override {
    plog(L"#%ld ShowDialog(%d)", id_, dialog);
    if (dialog == VfwCompressDialog_QueryConfig || dialog == VfwCompressDialog_QueryAbout)
      return S_OK;
    if (dialog == VfwCompressDialog_Config || dialog == VfwCompressDialog_About) {
      MessageBoxW(parent,
                  L"MMDEncoder 实验插件：只记录日志，不生成成片。\n"
                  L"日志在 %LOCALAPPDATA%\\MMDEncoder\\mmd-plugin\\logs",
                  L"MMDEncoder (Probe)", MB_OK | MB_ICONINFORMATION);
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
    if (index > 1) return DMO_E_NO_MORE_ITEMS;
    if (!mt) return S_OK;
    HRESULT hr = MoInitMediaType(mt, 0);
    if (FAILED(hr)) return hr;
    mt->majortype = MEDIATYPE_Video;
    mt->subtype = index == 0 ? MEDIASUBTYPE_RGB32 : MEDIASUBTYPE_RGB24;
    mt->formattype = GUID_NULL;
    return S_OK;
  }
  STDMETHODIMP GetOutputType(DWORD s, DWORD index, DMO_MEDIA_TYPE* mt) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!haveIn_) return DMO_E_TYPE_NOT_SET;
    if (index > 0) return DMO_E_NO_MORE_ITEMS;
    if (!mt) return S_OK;
    return buildOutput(mt);
  }
  STDMETHODIMP SetInputType(DWORD s, const DMO_MEDIA_TYPE* mt, DWORD flags) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    std::lock_guard<std::mutex> lock(mutex_);
    if (flags & DMO_SET_TYPEF_CLEAR) {
      plog(L"#%ld SetInputType clear", id_);
      if (haveIn_) MoFreeMediaType(&in_);
      haveIn_ = false;
      return S_OK;
    }
    if (!mt) return E_POINTER;
    logType(L"SetInputType", mt, flags);
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
    std::lock_guard<std::mutex> lock(mutex_);
    if (flags & DMO_SET_TYPEF_CLEAR) {
      if (haveOut_) MoFreeMediaType(&out_);
      haveOut_ = false;
      return S_OK;
    }
    if (!mt) return E_POINTER;
    logType(L"SetOutputType", mt, flags);
    if (!haveIn_) return DMO_E_TYPE_NOT_SET;
    if (mt->majortype != MEDIATYPE_Video || mt->subtype != MEDIASUBTYPE_MMDE)
      return DMO_E_TYPE_NOT_ACCEPTED;
    if (flags & DMO_SET_TYPEF_TEST_ONLY) return S_OK;
    if (haveOut_) MoFreeMediaType(&out_);
    MoCopyMediaType(&out_, mt);
    haveOut_ = true;
    return S_OK;
  }
  STDMETHODIMP GetInputCurrentType(DWORD s, DMO_MEDIA_TYPE* mt) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!haveIn_) return DMO_E_TYPE_NOT_SET;
    return mt ? MoCopyMediaType(mt, &in_) : E_POINTER;
  }
  STDMETHODIMP GetOutputCurrentType(DWORD s, DMO_MEDIA_TYPE* mt) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!haveOut_) return DMO_E_TYPE_NOT_SET;
    return mt ? MoCopyMediaType(mt, &out_) : E_POINTER;
  }
  STDMETHODIMP GetInputSizeInfo(DWORD s, DWORD* size, DWORD* lookahead,
                                DWORD* align) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!haveIn_) return DMO_E_TYPE_NOT_SET;
    if (!size || !lookahead || !align) return E_POINTER;
    *size = frameBytes();
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
    std::lock_guard<std::mutex> lock(mutex_);
    plog(L"#%ld Flush (frames so far %llu)", id_, frames_);
    releasePending();
    return S_OK;
  }
  STDMETHODIMP Discontinuity(DWORD s) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    plog(L"#%ld Discontinuity (frames so far %llu)", id_, frames_);
    return S_OK;
  }
  STDMETHODIMP AllocateStreamingResources() override {
    plog(L"#%ld AllocateStreamingResources", id_);
    return S_OK;
  }
  STDMETHODIMP FreeStreamingResources() override {
    finish(L"FreeStreamingResources");
    return S_OK;
  }
  STDMETHODIMP GetInputStatus(DWORD s, DWORD* flags) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    if (!flags) return E_POINTER;
    std::lock_guard<std::mutex> lock(mutex_);
    *flags = pending_ ? 0 : DMO_INPUT_STATUSF_ACCEPT_DATA;
    return S_OK;
  }
  STDMETHODIMP ProcessInput(DWORD s, IMediaBuffer* buffer, DWORD flags, REFERENCE_TIME time,
                            REFERENCE_TIME length) override {
    if (s) return DMO_E_INVALIDSTREAMINDEX;
    if (!buffer) return E_POINTER;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!haveIn_) return DMO_E_TYPE_NOT_SET;
    if (pending_) return DMO_E_NOTACCEPTING;
    BYTE* data = nullptr;
    DWORD bytes = 0;
    buffer->GetBufferAndLength(&data, &bytes);
    if (!frames_) firstFrame(data, bytes, flags, time, length);
    if (frames_ < 5 || frames_ % 600 == 0)
      plog(L"#%ld frame %llu: %lu bytes flags=0x%lx time=%lld length=%lld", id_, frames_, bytes,
           flags, (flags & DMO_INPUT_DATA_BUFFERF_TIME) ? time : -1,
           (flags & DMO_INPUT_DATA_BUFFERF_TIMELENGTH) ? length : -1);
    lastTime_ = (flags & DMO_INPUT_DATA_BUFFERF_TIME) ? time : -1;
    lastLength_ = (flags & DMO_INPUT_DATA_BUFFERF_TIMELENGTH) ? length : -1;
    pendingFlags_ = flags;
    pendingTime_ = time;
    pendingLength_ = length;
    pending_ = true;
    frames_++;
    return S_OK;
  }
  STDMETHODIMP ProcessOutput(DWORD flags, DWORD count, DMO_OUTPUT_DATA_BUFFER* out,
                             DWORD* status) override {
    if (!out || !status || count != 1) return E_INVALIDARG;
    std::lock_guard<std::mutex> lock(mutex_);
    *status = 0;
    out[0].dwStatus = 0;
    if (!pending_) return S_FALSE;
    if (!out[0].pBuffer) {
      // Caller only wanted to discard; drop the frame.
      pending_ = false;
      return S_OK;
    }
    BYTE* data = nullptr;
    DWORD max = 0;
    out[0].pBuffer->GetMaxLength(&max);
    out[0].pBuffer->GetBufferAndLength(&data, nullptr);
    if (max < kPlaceholderBytes || !data) return E_FAIL;
    // Placeholder sample: "MMDE" + frame index; the real plugin will do the same.
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
    outputs_++;
    return S_OK;
  }
  STDMETHODIMP Lock(LONG) override { return S_OK; }

 private:
  DWORD frameBytes() const {
    const auto& b = inInfo_.bmiHeader;
    DWORD stride = ((DWORD)b.biWidth * b.biBitCount / 8 + 3) & ~3u;
    return stride * (DWORD)std::abs(b.biHeight);
  }
  HRESULT buildOutput(DMO_MEDIA_TYPE* mt) {
    HRESULT hr = MoInitMediaType(mt, sizeof(VIDEOINFOHEADER));
    if (FAILED(hr)) return hr;
    mt->majortype = MEDIATYPE_Video;
    mt->subtype = MEDIASUBTYPE_MMDE;
    mt->formattype = FORMAT_VideoInfo;
    mt->bFixedSizeSamples = FALSE;
    mt->bTemporalCompression = FALSE;
    mt->lSampleSize = 0;
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
  void releasePending() { pending_ = false; }

  // Everything that is only interesting once, at the start of a render.
  void firstFrame(const BYTE* data, DWORD bytes, DWORD flags, REFERENCE_TIME time,
                  REFERENCE_TIME length) {
    started_ = GetTickCount64();
    plog(L"#%ld ===== first frame: %lu bytes (expected %lu)", id_, bytes, frameBytes());
    logType(L"current input", &in_, 0);
    logAviFiles(L"first frame");
    dumpWindows(L"first frame");
    logProjectAudio();
    const auto& b = inInfo_.bmiHeader;
    if (b.biBitCount == 32 && data && bytes >= frameBytes()) {
      unsigned minA = 255, maxA = 0;
      unsigned long long transparent = 0, pixels = (unsigned long long)b.biWidth * std::abs(b.biHeight);
      for (unsigned long long i = 0; i < pixels; i++) {
        unsigned a = data[i * 4 + 3];
        minA = std::min(minA, a);
        maxA = std::max(maxA, a);
        if (a < 255) transparent++;
      }
      plog(L"  alpha: min=%u max=%u non-opaque pixels=%llu of %llu", minA, maxA, transparent,
           pixels);
    }
    if (data && bytes >= frameBytes()) saveBitmap(data);
  }
  void saveBitmap(const BYTE* data) {
    std::wstring path = Log::get().dir() + L"\\first-frame-" + std::to_wstring(GetCurrentProcessId()) +
                        L"-" + std::to_wstring(id_) + L".bmp";
    BITMAPFILEHEADER fh{};
    BITMAPINFOHEADER ih = inInfo_.bmiHeader;
    ih.biSize = sizeof(ih);
    ih.biSizeImage = frameBytes();
    fh.bfType = 0x4D42;
    fh.bfOffBits = sizeof(fh) + sizeof(ih);
    fh.bfSize = fh.bfOffBits + ih.biSizeImage;
    HANDLE f = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
    if (f == INVALID_HANDLE_VALUE) return;
    DWORD w = 0;
    WriteFile(f, &fh, sizeof(fh), &w, nullptr);
    WriteFile(f, &ih, sizeof(ih), &w, nullptr);
    WriteFile(f, data, ih.biSizeImage, &w, nullptr);
    CloseHandle(f);
    plog(L"  first frame saved: %s", path.c_str());
  }
  void finish(const wchar_t* why) {
    if (finished_ || !frames_) {
      if (!frames_) plog(L"#%ld %s (no frames)", id_, why);
      return;
    }
    finished_ = true;
    double seconds = (GetTickCount64() - started_) / 1000.0;
    plog(L"#%ld ===== %s: %llu frames in, %llu placeholders out, %.2f s, last time=%lld "
         L"length=%lld",
         id_, why, frames_, outputs_, seconds, lastTime_, lastLength_);
    logAviFiles(L"end");
    dumpWindows(L"end");
  }

  // The non-delegating IUnknown: owns the reference count and answers QI.
  class Inner : public IUnknown {
   public:
    explicit Inner(Probe* owner) : owner_(owner) {}
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
      if (!ppv) return E_POINTER;
      *ppv = nullptr;
      if (riid == IID_IUnknown) {
        *ppv = static_cast<IUnknown*>(this);
      } else if (riid == IID_IMediaObject) {
        *ppv = static_cast<IMediaObject*>(owner_);
      } else if (riid == IID_IAMVfwCompressDialogs) {
        *ppv = static_cast<IAMVfwCompressDialogs*>(owner_);
      } else {
        // Record what the host asks for, so missing interfaces show up in the log.
        plog(L"#%ld QueryInterface %s -> not supported", owner_->id_, guidText(riid).c_str());
        return E_NOINTERFACE;
      }
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
    Probe* owner_;
    std::atomic<ULONG> refs_{1};
  };

  static inline std::atomic<long> counter_{0};
  Inner inner_;
  IUnknown* outer_;
  std::mutex mutex_;
  long id_ = 0;
  DMO_MEDIA_TYPE in_{}, out_{};
  VIDEOINFOHEADER inInfo_{};
  bool haveIn_ = false, haveOut_ = false, pending_ = false, finished_ = false;
  DWORD pendingFlags_ = 0;
  REFERENCE_TIME pendingTime_ = 0, pendingLength_ = 0, lastTime_ = -1, lastLength_ = -1;
  unsigned long long frames_ = 0, outputs_ = 0;
  ULONGLONG started_ = 0;
};

// ------------------------------------------------------- class factory ---

class Factory : public IClassFactory {
 public:
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IClassFactory) {
      *ppv = static_cast<IClassFactory*>(this);
      AddRef();
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
    // COM rule: an aggregating outer object must ask for IUnknown.
    if (outer && riid != IID_IUnknown) return CLASS_E_NOAGGREGATION;
    auto* p = new (std::nothrow) Probe(outer);
    if (!p) return E_OUTOFMEMORY;
    HRESULT hr = p->inner()->QueryInterface(riid, ppv);
    p->inner()->Release();  // drop the construction reference
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
  if (clsid != CLSID_MMDEncoderProbe) return CLASS_E_CLASSNOTAVAILABLE;
  return g_factory.QueryInterface(riid, ppv);
}

STDAPI DllCanUnloadNow() { return g_objects == 0 && g_locks == 0 ? S_OK : S_FALSE; }

static LONG setString(HKEY root, const std::wstring& key, const wchar_t* name,
                      const std::wstring& value) {
  HKEY k;
  LONG r = RegCreateKeyExW(root, key.c_str(), 0, nullptr, 0, KEY_WRITE, nullptr, &k, nullptr);
  if (r) return r;
  r = RegSetValueExW(k, name, 0, REG_SZ, (const BYTE*)value.c_str(),
                     (DWORD)((value.size() + 1) * sizeof(wchar_t)));
  RegCloseKey(k);
  return r;
}
static LONG setBinary(HKEY root, const std::wstring& key, const wchar_t* name,
                      const std::vector<GUID>& guids) {
  HKEY k;
  LONG r = RegCreateKeyExW(root, key.c_str(), 0, nullptr, 0, KEY_WRITE, nullptr, &k, nullptr);
  if (r) return r;
  r = RegSetValueExW(k, name, 0, REG_BINARY, (const BYTE*)guids.data(),
                     (DWORD)(guids.size() * sizeof(GUID)));
  RegCloseKey(k);
  return r;
}

// Per-user registration (HKCU), so no administrator rights are needed.
STDAPI DllRegisterServer() {
  wchar_t path[MAX_PATH];
  GetModuleFileNameW(g_module, path, MAX_PATH);
  const std::wstring clsid = std::wstring(L"Software\\Classes\\CLSID\\") + kClsidText;
  const std::wstring dmo = std::wstring(L"Software\\Classes\\DirectShow\\MediaObjects\\") + kClsidBare;
  const std::wstring cat = std::wstring(L"Software\\Classes\\DirectShow\\MediaObjects\\Categories\\") +
                           kCategoryBare + L"\\" + kClsidBare;
  LONG r = setString(HKEY_CURRENT_USER, clsid, nullptr, kName);
  if (!r) r = setString(HKEY_CURRENT_USER, clsid + L"\\InprocServer32", nullptr, path);
  if (!r) r = setString(HKEY_CURRENT_USER, clsid + L"\\InprocServer32", L"ThreadingModel", L"Both");
  if (!r) r = setString(HKEY_CURRENT_USER, dmo, nullptr, kName);
  if (!r)
    r = setBinary(HKEY_CURRENT_USER, dmo, L"InputTypes",
                  {MEDIATYPE_Video, MEDIASUBTYPE_RGB32, MEDIATYPE_Video, MEDIASUBTYPE_RGB24});
  if (!r) r = setBinary(HKEY_CURRENT_USER, dmo, L"OutputTypes", {MEDIATYPE_Video, MEDIASUBTYPE_MMDE});
  if (!r) r = setString(HKEY_CURRENT_USER, cat, nullptr, L"");
  return r ? HRESULT_FROM_WIN32(r) : S_OK;
}

STDAPI DllUnregisterServer() {
  const std::wstring clsid = std::wstring(L"Software\\Classes\\CLSID\\") + kClsidText;
  const std::wstring dmo = std::wstring(L"Software\\Classes\\DirectShow\\MediaObjects\\") + kClsidBare;
  const std::wstring cat = std::wstring(L"Software\\Classes\\DirectShow\\MediaObjects\\Categories\\") +
                           kCategoryBare + L"\\" + kClsidBare;
  RegDeleteTreeW(HKEY_CURRENT_USER, cat.c_str());
  RegDeleteKeyW(HKEY_CURRENT_USER, cat.c_str());
  RegDeleteTreeW(HKEY_CURRENT_USER, dmo.c_str());
  RegDeleteKeyW(HKEY_CURRENT_USER, dmo.c_str());
  RegDeleteTreeW(HKEY_CURRENT_USER, clsid.c_str());
  RegDeleteKeyW(HKEY_CURRENT_USER, clsid.c_str());
  return S_OK;
}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = module;
    DisableThreadLibraryCalls(module);
  }
  return TRUE;
}

