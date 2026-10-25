#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "platform.h"
#include <algorithm>
#include <knownfolders.h>
#include <shlobj.h>

std::wstring utf16(const std::string& s, UINT cp) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(cp, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(cp, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}
std::string utf8(const std::wstring& w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}
std::wstring pluginDir() {
  PWSTR base = nullptr;
  std::wstring dir;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &base))) {
    dir = std::wstring(base) + L"\\MMDEncoder\\mmd-plugin";
    CoTaskMemFree(base);
  }
  return dir;
}

bool readFile(const std::wstring& path, std::string& out) {
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

