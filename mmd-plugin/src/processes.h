#pragma once
#include <windows.h>
#include <string>
#include <utility>
#include <vector>

using ProcessLog = void (*)(const wchar_t* format, ...);

std::wstring quoteArg(const std::wstring& a);
std::vector<wchar_t> environmentWith(const std::vector<std::pair<std::wstring, std::wstring>>& add);
// The non-inheritable job handle belongs to the caller. Explicit termination
// ends descendants; closing the handle alone lets them drain EOF and recover.
bool startProcessGroup(const std::wstring& exe, std::wstring& command, void* environment,
                       STARTUPINFOW& startup, PROCESS_INFORMATION& process, HANDLE& group);
bool runHelper(const std::wstring& exe, const std::wstring& helper, const std::wstring& mode,
               const std::string& job, std::string& out, DWORD timeoutMs, ProcessLog log, HWND responsive = nullptr);
