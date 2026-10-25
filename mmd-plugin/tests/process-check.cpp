#define WIN32_LEAN_AND_MEAN
#include "../src/processes.h"
#include <cstdio>
// Test the same suspended-start / job assignment used by the DLL, without
// touching a user's MMD process, shared configuration or plugin registration.
int wmain(int argc, wchar_t** argv) {
  if (argc != 3) return 2;
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                             &sa, OPEN_EXISTING, 0, nullptr);
  STARTUPINFOW si{sizeof(si)};
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = input;
  si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION pi{};
  HANDLE group = nullptr;
  std::wstring command = quoteArg(argv[1]) + L" " + quoteArg(argv[2]);
  bool started = startProcessGroup(argv[1], command, nullptr, si, pi, group);
  CloseHandle(input);
  if (!started) return 3;
  CloseHandle(pi.hThread);
  std::puts("ready"); std::fflush(stdout);
  std::getchar(); // The test asks for explicit group termination.
  TerminateJobObject(group, 1);
  CloseHandle(group);
  DWORD wait = WaitForSingleObject(pi.hProcess, 5000);
  CloseHandle(pi.hProcess);
  return wait == WAIT_OBJECT_0 ? 0 : 4;
}
