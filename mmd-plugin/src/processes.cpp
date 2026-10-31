#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "processes.h"
#include "platform.h"
#include <algorithm>

// ----------------------------------------------------------- processes ---

// Quote one argument the way CommandLineToArgvW / the MSVC runtime parse it.
std::wstring quoteArg(const std::wstring& a) {
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
std::vector<wchar_t> environmentWith(const std::vector<std::pair<std::wstring, std::wstring>>& add) {
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

// Assign while suspended so no descendant can escape the owning job.
bool startProcessGroup(const std::wstring& exe, std::wstring& command, void* environment,
                       STARTUPINFOW& startup, PROCESS_INFORMATION& process, HANDLE& group) {
  group = CreateJobObjectW(nullptr, nullptr);
  if (!group) return false;
  // Closing MMD must close the raw-frame pipe, not kill the encoders: EOF
  // lets them write the trailer needed by interrupted-export recovery.
  // Explicit failure/timeout still uses TerminateJobObject on this handle.
  const BOOL ok = CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, TRUE,
    CREATE_NO_WINDOW | CREATE_SUSPENDED | (environment ? CREATE_UNICODE_ENVIRONMENT : 0),
    environment, nullptr, &startup, &process);
  if (!ok || !AssignProcessToJobObject(group, process.hProcess) || ResumeThread(process.hThread) == (DWORD)-1) {
    if (ok) {
      TerminateProcess(process.hProcess, 1);
      WaitForSingleObject(process.hProcess, 5000);
      CloseHandle(process.hThread);
      CloseHandle(process.hProcess);
      process = {};
    }
    CloseHandle(group);
    group = nullptr;
    return false;
  }
  return true;
}

// Run MMDEncoder.exe in Node mode with the helper script; returns its stdout.
bool runHelper(const std::wstring& exe, const std::wstring& helper, const std::wstring& mode,
                      const std::string& job, std::string& out, DWORD timeoutMs, ProcessLog log, HWND responsive) {
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
    log(L"cannot start helper %s (error %lu)", exe.c_str(), GetLastError());
    CloseHandle(readPipe);
    return false;
  }
  // Read only what is already in the pipe, so a helper that hangs without
  // writing or exiting cannot block past the deadline (a plain ReadFile on an
  // anonymous pipe would wait forever). The pipe breaks once the helper has
  // exited and everything it wrote has been read.
  char buf[4096];
  const ULONGLONG deadline = GetTickCount64() + timeoutMs;
  bool timedOut = false;
  for (;;) {
    DWORD avail = 0, n = 0;
    if (!PeekNamedPipe(readPipe, nullptr, 0, nullptr, &avail, nullptr)) break;
    if (avail) {
      if (!ReadFile(readPipe, buf, (std::min)(avail, (DWORD)sizeof(buf)), &n, nullptr) || !n) break;
      out.append(buf, n);
      continue;
    }
    if (GetTickCount64() > deadline) {
      timedOut = true;
      break;
    }
    WaitForSingleObject(pi.hProcess, 20);
    // The settings test may take a few seconds; keep its dialog painting and
    // processing messages while its controls are disabled against reentry.
    if (responsive) {
      MSG msg;
      while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
        if (!IsDialogMessageW(responsive, &msg)) {
          TranslateMessage(&msg);
          DispatchMessageW(&msg);
        }
      }
    }
  }
  CloseHandle(readPipe);
  if (timedOut) {
    log(L"helper %s gave no answer within %lu ms; stopped", mode.c_str(), timeoutMs);
    TerminateProcess(pi.hProcess, 1);
  }
  WaitForSingleObject(pi.hProcess, 5000);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return !timedOut;
}

