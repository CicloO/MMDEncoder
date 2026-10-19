// Test host for the experimental plugin: loads the DLL without registering it,
// negotiates types the way MMD's AVI writer does, feeds frames and checks the
// placeholder output. Usage: probe-host.exe <path to MMDEncoderProbe.dll> <temp dir>
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cguid.h>
#include <knownfolders.h>
#include <mediaobj.h>
#include <dmo.h>
#include <uuids.h>
#include <amvideo.h>
#include <dmoreg.h>
#include <strmif.h>
#include <oaidl.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#pragma comment(lib, "msdmo.lib")
#pragma comment(lib, "dmoguids.lib")
#pragma comment(lib, "strmiids.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "oleaut32.lib")

static const GUID CLSID_MMDEncoderProbe = {
    0xdc2177df, 0x7421, 0x4112, {0xb1, 0xc1, 0xea, 0x4a, 0xb1, 0x30, 0xee, 0x8b}};

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
  STDMETHODIMP SetLength(DWORD n) override {
    if (n > data_.size()) return E_INVALIDARG;
    length_ = n;
    return S_OK;
  }
  STDMETHODIMP GetMaxLength(DWORD* n) override {
    *n = (DWORD)data_.size();
    return S_OK;
  }
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

static int failures = 0;
static void check(bool ok, const char* what) {
  std::printf("%s %s\n", ok ? "PASS" : "FAIL", what);
  if (!ok) failures++;
}

// --enum: list what Windows offers as video encoders, the way MMD's AVI dialog
// finds them (DMO category and the DirectShow video compressor category).
static int enumerate() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  IEnumDMO* e = nullptr;
  bool dmoFound = false;
  if (SUCCEEDED(DMOEnum(DMOCATEGORY_VIDEO_ENCODER, DMO_ENUMF_INCLUDE_KEYED, 0, nullptr, 0, nullptr,
                        &e))) {
    CLSID id;
    WCHAR* name = nullptr;
    while (e->Next(1, &id, &name, nullptr) == S_OK) {
      if (id == CLSID_MMDEncoderProbe) dmoFound = true;
      std::wprintf(L"  DMO: %ls\n", name ? name : L"?");
      CoTaskMemFree(name);
    }
    e->Release();
  }
  bool devFound = false, filterOk = false, dialogs = false;
  int pinCount = 0;
  ICreateDevEnum* dev = nullptr;
  IEnumMoniker* monikers = nullptr;
  if (SUCCEEDED(CoCreateInstance(CLSID_SystemDeviceEnum, nullptr, CLSCTX_INPROC_SERVER,
                                 IID_ICreateDevEnum, (void**)&dev)) &&
      dev->CreateClassEnumerator(CLSID_VideoCompressorCategory, &monikers, 0) == S_OK) {
    IMoniker* m = nullptr;
    while (monikers->Next(1, &m, nullptr) == S_OK) {
      IPropertyBag* bag = nullptr;
      if (SUCCEEDED(m->BindToStorage(nullptr, nullptr, IID_IPropertyBag, (void**)&bag))) {
        VARIANT v;
        VariantInit(&v);
        if (SUCCEEDED(bag->Read(L"FriendlyName", &v, nullptr)) && v.vt == VT_BSTR) {
          std::wprintf(L"  DirectShow: %ls\n", v.bstrVal);
          if (wcsstr(v.bstrVal, L"MMDEncoder")) {
            devFound = true;
            // What MMD does next: turn the list entry into a filter. DirectShow
            // builds its DMO Wrapper, which creates our DMO aggregated.
            IBaseFilter* filter = nullptr;
            HRESULT hr = m->BindToObject(nullptr, nullptr, IID_IBaseFilter, (void**)&filter);
            std::printf("  BindToObject hr=0x%08lx\n", (unsigned long)hr);
            filterOk = SUCCEEDED(hr) && filter;
            if (filter) {
              IEnumPins* pins = nullptr;
              if (SUCCEEDED(filter->EnumPins(&pins))) {
                IPin* pin = nullptr;
                while (pins->Next(1, &pin, nullptr) == S_OK) {
                  pinCount++;
                  pin->Release();
                }
                pins->Release();
              }
              IAMVfwCompressDialogs* dlg = nullptr;
              if (SUCCEEDED(filter->QueryInterface(IID_IAMVfwCompressDialogs, (void**)&dlg))) {
                dialogs = dlg->ShowDialog(VfwCompressDialog_QueryConfig, nullptr) == S_OK;
                dlg->Release();
              }
              filter->Release();
            }
          }
        }
        VariantClear(&v);
        bag->Release();
      }
      m->Release();
    }
    monikers->Release();
  }
  if (dev) dev->Release();
  check(dmoFound, "listed as a DMO video encoder");
  check(devFound, "listed in DirectShow video compressors (what MMD shows)");
  check(filterOk, "DirectShow creates it as a filter through the DMO Wrapper (aggregation)");
  check(pinCount == 2, "filter has an input and an output pin");
  check(dialogs, "settings dialog interface reachable from the filter");
  CoUninitialize();
  return failures ? 1 : 0;
}

int main(int argc, char** argv) {
  if (argc >= 2 && std::strcmp(argv[1], "--enum") == 0) return enumerate();
  if (argc < 3) {
    std::printf("usage: probe-host <dll> <temp dir>\n");
    return 2;
  }
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  HMODULE dll = LoadLibraryA(argv[1]);
  check(dll != nullptr, "load DLL");
  if (!dll) return 1;
  using GetClassObject = HRESULT(STDAPICALLTYPE*)(REFCLSID, REFIID, void**);
  auto get = (GetClassObject)GetProcAddress(dll, "DllGetClassObject");
  IClassFactory* factory = nullptr;
  check(get && SUCCEEDED(get(CLSID_MMDEncoderProbe, IID_IClassFactory, (void**)&factory)),
        "class factory");
  {
    // Aggregated creation, the way the DirectShow DMO Wrapper does it.
    struct Outer : IUnknown {
      IUnknown* inner = nullptr;
      ULONG refs = 1;
      STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (riid == IID_IUnknown) {
          *ppv = this;
          AddRef();
          return S_OK;
        }
        return inner->QueryInterface(riid, ppv);
      }
      STDMETHODIMP_(ULONG) AddRef() override { return ++refs; }
      STDMETHODIMP_(ULONG) Release() override { return --refs; }
    } outer;
    void* wrong = nullptr;
    check(factory && factory->CreateInstance(&outer, IID_IMediaObject, &wrong) ==
                         CLASS_E_NOAGGREGATION,
          "aggregation must ask for IUnknown");
    check(factory &&
              SUCCEEDED(factory->CreateInstance(&outer, IID_IUnknown, (void**)&outer.inner)),
          "aggregated creation");
    if (outer.inner) {
      IMediaObject* mo = nullptr;
      ULONG before = outer.refs;
      check(SUCCEEDED(outer.inner->QueryInterface(IID_IMediaObject, (void**)&mo)) &&
                outer.refs == before + 1,
            "inner QI hands out IMediaObject that counts on the outer object");
      IUnknown* viaMo = nullptr;
      check(mo && SUCCEEDED(mo->QueryInterface(IID_IUnknown, (void**)&viaMo)) &&
                viaMo == static_cast<IUnknown*>(&outer),
            "IMediaObject QI for IUnknown returns the outer object");
      if (viaMo) viaMo->Release();
      if (mo) mo->Release();
      outer.inner->Release();
    }
  }
  IMediaObject* dmo = nullptr;
  check(factory && SUCCEEDED(factory->CreateInstance(nullptr, IID_IMediaObject, (void**)&dmo)),
        "create IMediaObject");
  if (!dmo) return 1;

  // Input type enumeration: RGB32 then RGB24.
  DMO_MEDIA_TYPE t{};
  check(dmo->GetInputType(0, 0, &t) == S_OK && t.subtype == MEDIASUBTYPE_RGB32, "input type 0 RGB32");
  MoFreeMediaType(&t);
  check(dmo->GetInputType(0, 1, &t) == S_OK && t.subtype == MEDIASUBTYPE_RGB24, "input type 1 RGB24");
  MoFreeMediaType(&t);
  check(dmo->GetInputType(0, 2, &t) == DMO_E_NO_MORE_ITEMS, "no third input type");
  check(dmo->GetOutputType(0, 0, &t) == DMO_E_TYPE_NOT_SET, "output type needs input first");

  // 320x180 RGB32 bottom-up at 60 fps, as an AVI writer would offer it.
  const LONG w = 320, h = 180;
  DMO_MEDIA_TYPE in{};
  MoInitMediaType(&in, sizeof(VIDEOINFOHEADER));
  in.majortype = MEDIATYPE_Video;
  in.subtype = MEDIASUBTYPE_RGB32;
  in.formattype = FORMAT_VideoInfo;
  in.bFixedSizeSamples = TRUE;
  in.lSampleSize = w * h * 4;
  auto* v = (VIDEOINFOHEADER*)in.pbFormat;
  ZeroMemory(v, sizeof(*v));
  v->AvgTimePerFrame = 166667;
  v->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  v->bmiHeader.biWidth = w;
  v->bmiHeader.biHeight = h;
  v->bmiHeader.biPlanes = 1;
  v->bmiHeader.biBitCount = 32;
  v->bmiHeader.biCompression = BI_RGB;
  v->bmiHeader.biSizeImage = w * h * 4;
  check(dmo->SetInputType(0, &in, DMO_SET_TYPEF_TEST_ONLY) == S_OK, "test-only input type accepted");
  check(dmo->SetInputType(0, &in, 0) == S_OK, "set input type");

  DMO_MEDIA_TYPE bad{};
  MoCopyMediaType(&bad, &in);
  ((VIDEOINFOHEADER*)bad.pbFormat)->bmiHeader.biCompression = MAKEFOURCC('H', '2', '6', '4');
  check(dmo->SetInputType(0, &bad, DMO_SET_TYPEF_TEST_ONLY) == DMO_E_TYPE_NOT_ACCEPTED,
        "compressed input rejected");
  MoFreeMediaType(&bad);

  DMO_MEDIA_TYPE out{};
  check(dmo->GetOutputType(0, 0, &out) == S_OK, "get output type");
  auto* ov = (VIDEOINFOHEADER*)out.pbFormat;
  check(ov && ov->bmiHeader.biCompression == MAKEFOURCC('M', 'M', 'D', 'E') &&
            ov->bmiHeader.biWidth == w && ov->bmiHeader.biHeight == h &&
            ov->AvgTimePerFrame == 166667,
        "output type is MMDE placeholder with input size and frame rate");
  check(dmo->SetOutputType(0, &out, 0) == S_OK, "set output type");
  DWORD size = 0, look = 0, align = 0;
  check(dmo->GetInputSizeInfo(0, &size, &look, &align) == S_OK && size == (DWORD)(w * h * 4),
        "input size = one frame");

  // Hold an .avi open, as MMD does with its output, so the probe can find it.
  std::string aviPath = std::string(argv[2]) + "\\probe-host-output.avi";
  HANDLE avi = CreateFileA(aviPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
                           0, nullptr);
  check(avi != INVALID_HANDLE_VALUE, "open test .avi");

  check(dmo->AllocateStreamingResources() == S_OK, "allocate streaming resources");
  int placeholders = 0;
  for (int i = 0; i < 10; i++) {
    Buffer* frame = new Buffer(w * h * 4);
    frame->length_ = w * h * 4;
    for (LONG p = 0; p < w * h; p++) {
      frame->data_[p * 4 + 0] = (BYTE)i;
      frame->data_[p * 4 + 1] = 0x80;
      frame->data_[p * 4 + 2] = 0xff;
      frame->data_[p * 4 + 3] = (BYTE)(p % w * 255 / (w - 1));  // alpha gradient
    }
    DWORD status = 0;
    dmo->GetInputStatus(0, &status);
    if (!(status & DMO_INPUT_STATUSF_ACCEPT_DATA)) check(false, "accepts data");
    HRESULT hr = dmo->ProcessInput(0, frame,
                                   DMO_INPUT_DATA_BUFFERF_TIME | DMO_INPUT_DATA_BUFFERF_TIMELENGTH,
                                   i * 166667LL, 166667LL);
    frame->Release();
    if (FAILED(hr)) check(false, "ProcessInput");
    dmo->GetInputStatus(0, &status);
    if (status & DMO_INPUT_STATUSF_ACCEPT_DATA) check(false, "busy until output is taken");
    Buffer* sample = new Buffer(64);
    DMO_OUTPUT_DATA_BUFFER ob{};
    ob.pBuffer = sample;
    DWORD st = 0;
    hr = dmo->ProcessOutput(0, 1, &ob, &st);
    if (hr == S_OK && sample->length_ == 16 && std::memcmp(sample->data_.data(), "MMDE", 4) == 0 &&
        *(unsigned long long*)(sample->data_.data() + 4) == (unsigned long long)i &&
        (ob.dwStatus & DMO_OUTPUT_DATA_BUFFERF_TIME) && ob.rtTimestamp == i * 166667LL)
      placeholders++;
    sample->Release();
  }
  check(placeholders == 10, "10 frames in, 10 placeholder samples out with matching times");
  Buffer* empty = new Buffer(64);
  DMO_OUTPUT_DATA_BUFFER ob{};
  ob.pBuffer = empty;
  DWORD st = 0;
  check(dmo->ProcessOutput(0, 1, &ob, &st) == S_FALSE, "no output without input");
  empty->Release();

  check(dmo->FreeStreamingResources() == S_OK, "free streaming resources");
  CloseHandle(avi);
  DeleteFileA(aviPath.c_str());
  MoFreeMediaType(&in);
  MoFreeMediaType(&out);
  dmo->Release();
  factory->Release();
  using CanUnload = HRESULT(STDAPICALLTYPE*)();
  auto canUnload = (CanUnload)GetProcAddress(dll, "DllCanUnloadNow");
  check(canUnload && canUnload() == S_OK, "DLL can unload when all objects are released");
  std::printf(failures ? "HOST FAILED (%d)\n" : "HOST OK\n", failures);
  CoUninitialize();
  return failures ? 1 : 0;
}
