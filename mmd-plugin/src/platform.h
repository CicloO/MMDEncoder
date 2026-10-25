#pragma once
#include <windows.h>
#include <string>

std::wstring utf16(const std::string& s, UINT cp = CP_UTF8);
std::string utf8(const std::wstring& w);
std::wstring pluginDir();
bool readFile(const std::wstring& path, std::string& out);
