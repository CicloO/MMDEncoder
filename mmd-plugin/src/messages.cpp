#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include "messages.h"
#include <cstdio>
#include <utility>
#include "../build/plugin-messages.generated.h"

PluginMessages::PluginMessages(const Json& config)
    : locale_(config[L"locale"].s.empty() ? L"zh-CN" : config[L"locale"].s), messages_(config[L"messages"]) {}

std::wstring PluginMessages::number(double value, int digits) const {
  wchar_t raw[128], output[256], decimal[8] = L".", separator[8] = L",";
  swprintf_s(raw, L"%.*f", digits, value);
  GetLocaleInfoEx(locale_.c_str(), LOCALE_SDECIMAL, decimal, 8);
  GetLocaleInfoEx(locale_.c_str(), LOCALE_STHOUSAND, separator, 8);
  NUMBERFMTW format{};
  format.NumDigits = digits; format.LeadingZero = 1; format.Grouping = 0;
  format.lpDecimalSep = decimal; format.lpThousandSep = separator; format.NegativeOrder = 1;
  if (GetNumberFormatEx(locale_.c_str(), 0, raw, &format, output, 256)) return output;
  return raw;
}

std::wstring PluginMessages::format(const wchar_t* key, const Json& params, const std::wstring& fallback) const {
  std::wstring pattern = messages_[key].s;
  if (pattern.empty())
    for (const auto& entry : kPluginFallback)
      if (std::wstring(entry.first) == key) { pattern = entry.second; break; }
  if (pattern.empty()) return fallback.empty() ? key : fallback;
  std::wstring out;
  for (size_t at = 0; at < pattern.size();) {
    size_t start = pattern.find(L'{', at);
    if (start == std::wstring::npos) { out += pattern.substr(at); break; }
    out += pattern.substr(at, start - at);
    size_t end = pattern.find(L'}', start + 1);
    if (end == std::wstring::npos) { out += pattern.substr(start); break; }
    std::wstring name = pattern.substr(start + 1, end - start - 1);
    const Json& value = params[name.c_str()];
    if (value.type == Json::String) out += value.s;
    else if (value.type == Json::Number) out += number(value.n, name == L"seconds" ? 1 : 0);
    else if (value.type == Json::Bool) out += value.b ? L"true" : L"false";
    else out += pattern.substr(start, end - start + 1);
    at = end + 1;
  }
  return out;
}

std::wstring PluginMessages::text(const wchar_t* key) const { return format(key, Json{}); }
std::wstring PluginMessages::result(const Json& data, const wchar_t* prefix, const std::wstring& fallback) const {
  if (data[L"code"].s.empty()) return fallback;
  Json params = data[L"params"];
  if (params[L"error"].type == Json::Object) {
    params.o[L"detail"].type = Json::String;
    params.o[L"detail"].s = result(params[L"error"], L"error.", params[L"error"][L"message"].s);
  }
  std::wstring output = format((std::wstring(prefix) + data[L"code"].s).c_str(), params, fallback);
  for (const Json& issue : data[L"issues"].a) {
    const std::wstring line = result(issue, L"error.", issue[L"message"].s);
    if (!line.empty()) output += (output.empty() ? L"" : L"\n") + line;
  }
  return output;
}

const wchar_t* PluginMessages::font() const {
  if (locale_.rfind(L"ja", 0) == 0) return L"Yu Gothic UI";
  if (locale_.rfind(L"zh", 0) == 0) return L"Microsoft YaHei UI";
  return L"Segoe UI";
}
