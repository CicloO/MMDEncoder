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

#include "json.h"
#include "platform.h"
#include "processes.h"
#include "settings.h"
#include "messages.h"

static Json textParam(const wchar_t* name, const std::wstring& value) {
  Json params; params.type = Json::Object;
  params.o[name].type = Json::String; params.o[name].s = value;
  return params;
}

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

static std::wstring guidText(const GUID& g) {
  wchar_t s[64];
  StringFromGUID2(g, s, 64);
  return s;
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
    if (encoderGroup_) CloseHandle(encoderGroup_);
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
      showSettings(parent, g_module, pluginDir(), plog);
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
    if (encoderGroup_) TerminateJobObject(encoderGroup_, 1);
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
    std::string raw;
    const bool hasConfig = readFile(pluginDir() + L"\\mmd-export.json", raw) && JsonReader(raw).parse(config_);
    messages_ = PluginMessages(hasConfig ? config_ : Json{});
    if (avi_.empty()) return fail(messages_.text(L"plugin.aviMissing"));
    if (!hasConfig) return fail(messages_.text(L"plugin.configMissing"));
    appExe_ = config_[L"appExe"].s;
    helper_ = config_[L"helper"].s;
    if (appExe_.empty() || helper_.empty()) return fail(messages_.text(L"plugin.configIncomplete"));

    // pmm and startFrame let a cut-off export be finished later (mmd-export recover()).
    char head[512];
    sprintf_s(head, ",\"width\":%ld,\"height\":%ld,\"bits\":%d,\"bottomUp\":%s,\"avgTimePerFrame\":%lld,\"startFrame\":%ld}",
              width_, height_, bits_, b.biHeight > 0 ? "true" : "false", inInfo_.AvgTimePerFrame, mmd_.startFrame);
    const std::string job = "{\"avi\":" + jsonString(avi_) + ",\"pmm\":" + jsonString(mmd_.pmm) + head;
    std::string reply;
    Json plan;
    if (!runHelper(appExe_, helper_, L"plan", job, reply, 30000, plog) || !JsonReader(reply).parse(plan))
      return fail(messages_.format(L"plugin.planMissing", textParam(L"detail", utf16(reply))));
    if (!plan[L"ok"].b) return fail(messages_.format(L"plugin.presetFailed",
      textParam(L"detail", messages_.result(plan[L"errorData"], L"error.", plan[L"error"].s))));
    temp_ = plan[L"temp"].s;
    output_ = plan[L"output"].s;
    std::wstring ffmpeg = plan[L"exe"].s;
    std::wstring cmd = quoteArg(ffmpeg);
    for (const Json& a : plan[L"args"].a) cmd += L" " + quoteArg(a.s);
    plog(L"output %s (preset %s)", output_.c_str(), plan[L"presetName"].s.c_str());
    if (!plan[L"maskOutput"].s.empty()) plog(L"alpha mask %s", plan[L"maskOutput"].s.c_str());
    for (size_t i = 0; i < plan[L"notes"].a.size(); ++i) {
      const std::wstring fallback = plan[L"notes"].a[i].s;
      const std::wstring value = i < plan[L"notesData"].a.size()
        ? messages_.result(plan[L"notesData"].a[i], L"message.", fallback) : fallback;
      plog(L"note: %s", value.c_str());
    }
    plog(L"ffmpeg: %s", cmd.c_str());

    // FFmpeg reads frames from stdin; its messages go to a log next to ours.
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    HANDLE readPipe = nullptr;
    if (!CreatePipe(&readPipe, &stdin_, &sa, 4 << 20)) return fail(messages_.text(L"plugin.pipeFailed"));
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
    // Variables the plan asks for (NVEncC presets run MMDEncoder.exe in Node
    // mode to drive FFmpeg and NVEncC); otherwise MMD's own environment.
    std::vector<std::pair<std::wstring, std::wstring>> extra;
    for (auto& kv : plan[L"env"].o)
      if (kv.second.type == Json::String) extra.push_back({kv.first, kv.second.s});
    std::vector<wchar_t> env;
    if (!extra.empty()) env = environmentWith(extra);
    const bool ok = startProcessGroup(ffmpeg, cmd, env.empty() ? nullptr : env.data(), si, pi, encoderGroup_);
    CloseHandle(readPipe);
    if (err != INVALID_HANDLE_VALUE) CloseHandle(err);
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    if (!ok) {
      CloseHandle(stdin_);
      stdin_ = nullptr;
      return fail(messages_.format(L"plugin.encoderStartFailed", textParam(L"path", ffmpeg)));
    }
    CloseHandle(pi.hThread);
    encoder_ = pi.hProcess;
    row_.resize((size_t)width_ * bits_ / 8);
  }

  void writeFrame(const BYTE* data, DWORD bytes) {
    const DWORD rowBytes = (DWORD)row_.size(), srcStride = stride();
    if (!data || bytes < srcStride * (DWORD)height_) return fail(messages_.text(L"plugin.frameSizeInvalid"));
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
    if (!ok) fail(messages_.text(L"plugin.encoderExited"));
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
        TerminateJobObject(encoderGroup_, 1);
        WaitForSingleObject(encoder_, 5000);
        fail(messages_.text(L"plugin.encoderTimeout"));
      }
      GetExitCodeProcess(encoder_, &code);
      CloseHandle(encoder_);
      encoder_ = nullptr;
      CloseHandle(encoderGroup_);
      encoderGroup_ = nullptr;
      if (code != 0) fail(messages_.format(L"plugin.encoderFailed", textParam(L"exitCode", std::to_wstring(code))));
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
      fail(messages_.text(L"plugin.finishStartFailed"));
    }
    Json params = textParam(L"detail", error_);
    params.o[L"path"].type = Json::String; params.o[L"path"].s = Log::get().path();
    std::wstring text = messages_.format(L"plugin.exportFailed", params);
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
  PluginMessages messages_;
  std::wstring avi_, temp_, output_, appExe_, helper_, error_;
  HANDLE stdin_ = nullptr, encoder_ = nullptr, encoderGroup_ = nullptr;
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
