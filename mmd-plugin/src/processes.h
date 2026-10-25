#pragma once
#include <windows.h>
#include <string>
#include <utility>
#include <vector>

using ProcessLog = void (*)(const wchar_t* format, ...);

std::wstring quoteArg(const std::wstring& a);
std::vector<wchar_t> environmentWith(const std::vector<std::pair<std::wstring, std::wstring>>& add);
bool runHelper(const std::wstring& exe, const std::wstring& helper, const std::wstring& mode,
               const std::string& job, std::string& out, DWORD timeoutMs, ProcessLog log, HWND responsive = nullptr);
