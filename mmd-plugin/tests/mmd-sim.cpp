// Simulates MMD towards the export plugin, for tests without MMD:
//  - a hidden main window "MikuMikuDance [<pmm>]" and a visible "RecWindow"
//    titled with the frame range, like MMD 9.32 while rendering;
//  - an open placeholder AVI (copied from a template) as MMD's output file;
//  - the DMO calls MMD's DirectShow graph makes, with ARGB32 bottom-up frames.
// Usage: mmd-sim <plugin.dll> <template.avi> <output.avi> <pmm> <width> <height>
//                <fps> <start frame> <end frame>
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cguid.h>
#include <mediaobj.h>
#include <dmo.h>
#include <uuids.h>
#include <amvideo.h>
#include <strmif.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <thread>

#pragma comment(lib, "msdmo.lib")
#pragma comment(lib, "dmoguids.lib")
#pragma comment(lib, "strmiids.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "user32.lib")

static const GUID CLSID_MMDEncoderPlugin = {
    0xdc3f6bd1, 0x923f, 0x467a, {0xbf, 0x73, 0xf1, 0x15, 0xaf, 0x70, 0x50, 0x33}};

class Buffer : public IMediaBuffer {
 public:
  explicit Buffer(DWORD size) : data_(size) {}
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (riid == IID_IUnknown || riid == IID_IMediaBuffer) {
      *ppv = this;
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG n = --refs_;
    if (!n) delete this;
    return n;
  }
  STDMETHODIMP SetLength(DWORD n) override { return n <= data_.size() ? (length_ = n, S_OK) : E_INVALIDARG; }
  STDMETHODIMP GetMaxLength(DWORD* n) override { return *n = (DWORD)data_.size(), S_OK; }
  STDMETHODIMP GetBufferAndLength(BYTE** p, DWORD* n) override {
    if (p) *p = data_.data();
    if (n) *n = length_;
    return S_OK;
  }
  std::vector<BYTE> data_;
  DWORD length_ = 0;

 private:
  ULONG refs_ = 1;
};

static std::wstring wide(const char* s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, nullptr, 0);
  std::wstring w(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s, -1, w.data(), n);
  w.resize(n - 1);
  return w;
}

static HWND makeWindow(const wchar_t* cls, const std::wstring& title, bool visible) {
  WNDCLASSW wc{};
  wc.lpfnWndProc = DefWindowProcW;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = cls;
  RegisterClassW(&wc);
  HWND h = CreateWindowExW(0, cls, title.c_str(), WS_OVERLAPPED, 0, 0, 100, 100, nullptr, nullptr,
                           wc.hInstance, nullptr);
  if (visible) ShowWindow(h, SW_SHOWNOACTIVATE);
  return h;
}

int wmain(int argc, wchar_t** argv) {
  setvbuf(stdout, nullptr, _IONBF, 0);
  // --dialog <plugin.dll>: open the codec settings window, as MMD's 詳細設定 does.
  if (argc >= 3 && (wcscmp(argv[1], L"--dialog") == 0 || wcscmp(argv[1], L"--dialog-test") == 0)) {
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    HMODULE dll = LoadLibraryW(argv[2]);
    using GetClassObject = HRESULT(STDAPICALLTYPE*)(REFCLSID, REFIID, void**);
    auto get = dll ? (GetClassObject)GetProcAddress(dll, "DllGetClassObject") : nullptr;
    IClassFactory* factory = nullptr;
    IAMVfwCompressDialogs* dlg = nullptr;
    if (!get || FAILED(get(CLSID_MMDEncoderPlugin, IID_IClassFactory, (void**)&factory)) ||
        FAILED(factory->CreateInstance(nullptr, IID_IAMVfwCompressDialogs, (void**)&dlg)))
      return std::printf("cannot create plugin\n"), 1;
    std::thread driver;
    bool tested = false;
    if (wcscmp(argv[1], L"--dialog-test") == 0 && argc == 5) {
      const DWORD threadId = GetCurrentThreadId();
      const int mask = _wtoi(argv[3]);
      const bool save = wcscmp(argv[4], L"save") == 0;
      driver = std::thread([&tested, threadId, mask, save] {
        // Inspect only windows belonging to this simulator's dialog thread.
        auto find = [threadId](bool settings) {
          struct Search { bool settings; HWND found; } query{settings, nullptr};
          EnumThreadWindows(threadId, [](HWND window, LPARAM data) -> BOOL {
            auto* q = reinterpret_cast<Search*>(data);
            wchar_t title[128]; GetWindowTextW(window, title, 128);
            const bool matches = q->settings ? GetDlgItem(window, 107) != nullptr
                                             : wcscmp(title, L"MMDEncoder") == 0;
            if (matches) { q->found = window; return FALSE; }
            return TRUE;
          }, (LPARAM)&query);
          return query.found;
        };
        HWND settings = nullptr;
        for (int i = 0; i < 500 && !settings; i++) { settings = find(true); Sleep(10); }
        if (!settings) { std::printf("settings window not found\n"); return; }
        std::printf("settings window found\n");
        std::printf("initialMask=%lld\n", (long long)SendDlgItemMessageW(settings, 104, CB_GETCURSEL, 0, 0));
        SendDlgItemMessageW(settings, 104, CB_SETCURSEL, mask, 0);
        PostMessageW(settings, WM_COMMAND, MAKEWPARAM(107, BN_CLICKED), (LPARAM)GetDlgItem(settings, 107));
        // The result is shown briefly on the test button (107), starting with
        // a check or a cross once the test is over; no message box opens.
        std::wstring text;
        for (int i = 0; i < 8500; i++) {
          wchar_t part[4096] = {0};
          GetDlgItemTextW(settings, 107, part, 4096);
          if (part[0] == L'\x2713' || part[0] == L'\x2717') { text = part; break; }
          Sleep(10);
        }
        if (text.empty()) { std::printf("test result not shown\n"); PostMessageW(settings, WM_CLOSE, 0, 0); return; }
        if (find(false)) std::printf("unexpected message box\n");
        int n = WideCharToMultiByte(CP_UTF8, 0, text.data(), (int)text.size(), nullptr, 0, nullptr, nullptr);
        std::string bytes(n, '\0');
        WideCharToMultiByte(CP_UTF8, 0, text.data(), (int)text.size(), bytes.data(), n, nullptr, nullptr);
        std::printf("testResult=%s\n", bytes.c_str());
        tested = true;
        PostMessageW(settings, WM_COMMAND, save ? IDOK : IDCANCEL, 0);
      });
    }
    HRESULT hr = dlg->ShowDialog(VfwCompressDialog_Config, nullptr);
    if (driver.joinable()) { driver.join(); if (!tested) return 1; }
    dlg->Release();
    factory->Release();
    std::printf("dialog closed hr=0x%08lx\n", (unsigned long)hr);
    return 0;
  }
  if (argc < 10) {
    std::printf("usage: mmd-sim <dll> <template.avi> <output.avi> <pmm> <w> <h> <fps> <start> <end>\n");
    return 2;
  }
  const std::wstring dllPath = argv[1], templ = argv[2], avi = argv[3], pmm = argv[4];
  const LONG w = _wtol(argv[5]), h = _wtol(argv[6]);
  const int fps = _wtoi(argv[7]), start = _wtoi(argv[8]), end = _wtoi(argv[9]);
  const int frames = (end - start + 1) * fps / 30;  // MMD includes the end frame
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  HWND main = makeWindow(L"Polygon Movie Maker", L"MikuMikuDance [" + pmm + L"]", false);
  wchar_t rec[128];
  swprintf_s(rec, L" %d\x30d5\x30ec\x30fc\x30e0\x9332\x753b\x4e2d(%d\x30d5\x30ec\x30fc\x30e0\x307e\x3067)", start, end);
  HWND recWindow = makeWindow(L"RecWindow", rec, true);

  // MMD's AVI: the placeholder template, held open for writing during the render.
  if (!CopyFileW(templ.c_str(), avi.c_str(), FALSE)) return std::printf("copy template failed\n"), 1;
  HANDLE aviHandle = CreateFileW(avi.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                                 OPEN_EXISTING, 0, nullptr);
  if (aviHandle == INVALID_HANDLE_VALUE) return std::printf("open avi failed\n"), 1;

  HMODULE dll = LoadLibraryW(dllPath.c_str());
  using GetClassObject = HRESULT(STDAPICALLTYPE*)(REFCLSID, REFIID, void**);
  auto get = dll ? (GetClassObject)GetProcAddress(dll, "DllGetClassObject") : nullptr;
  IClassFactory* factory = nullptr;
  IMediaObject* dmo = nullptr;
  if (!get || FAILED(get(CLSID_MMDEncoderPlugin, IID_IClassFactory, (void**)&factory)) ||
      FAILED(factory->CreateInstance(nullptr, IID_IMediaObject, (void**)&dmo)))
    return std::printf("cannot create plugin\n"), 1;

  DMO_MEDIA_TYPE in{};
  MoInitMediaType(&in, sizeof(VIDEOINFOHEADER));
  in.majortype = MEDIATYPE_Video;
  in.subtype = MEDIASUBTYPE_ARGB32;
  in.formattype = FORMAT_VideoInfo;
  auto* v = (VIDEOINFOHEADER*)in.pbFormat;
  ZeroMemory(v, sizeof(*v));
  v->AvgTimePerFrame = 10000000 / fps;
  v->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  v->bmiHeader.biWidth = w;
  v->bmiHeader.biHeight = h;  // bottom-up, like MMD
  v->bmiHeader.biPlanes = 1;
  v->bmiHeader.biBitCount = 32;
  v->bmiHeader.biCompression = BI_RGB;
  v->bmiHeader.biSizeImage = w * h * 4;
  DMO_MEDIA_TYPE out{};
  if (dmo->SetInputType(0, &in, 0) != S_OK || dmo->GetOutputType(0, 0, &out) != S_OK ||
      dmo->SetOutputType(0, &out, 0) != S_OK)
    return std::printf("type negotiation failed\n"), 1;
  dmo->AllocateStreamingResources();
  int placeholders = 0;
  for (int i = 0; i < frames; i++) {
    Buffer* frame = new Buffer(w * h * 4);
    frame->length_ = w * h * 4;
    // Bottom-up rows: the first rows in memory are the bottom of the picture.
    for (LONG y = 0; y < h; y++)
      for (LONG x = 0; x < w; x++) {
        BYTE* p = &frame->data_[((size_t)y * w + x) * 4];
        p[0] = (BYTE)(x * 255 / w);  // B
        p[1] = (BYTE)(i * 4);        // G
        p[2] = y < h / 2 ? 255 : 0;  // R: bottom half red
        p[3] = x < w * 3 / 4 ? 255 : 0;  // A: right quarter transparent
      }
    dmo->ProcessInput(0, frame, DMO_INPUT_DATA_BUFFERF_TIME | DMO_INPUT_DATA_BUFFERF_TIMELENGTH,
                      (REFERENCE_TIME)i * v->AvgTimePerFrame, v->AvgTimePerFrame);
    frame->Release();
    Buffer* sample = new Buffer(64);
    DMO_OUTPUT_DATA_BUFFER ob{};
    ob.pBuffer = sample;
    DWORD st = 0;
    if (dmo->ProcessOutput(0, 1, &ob, &st) == S_OK && std::memcmp(sample->data_.data(), "MMDE", 4) == 0)
      placeholders++;
    sample->Release();
  }
  SetWindowTextW(recWindow, L"done");
  dmo->FreeStreamingResources();
  dmo->Release();
  factory->Release();
  MoFreeMediaType(&in);
  MoFreeMediaType(&out);
  CloseHandle(aviHandle);  // MMD releases the AVI only after the graph stops
  DestroyWindow(recWindow);
  DestroyWindow(main);
  std::printf("frames=%d placeholders=%d\n", frames, placeholders);
  CoUninitialize();
  return placeholders == frames ? 0 : 1;
}
