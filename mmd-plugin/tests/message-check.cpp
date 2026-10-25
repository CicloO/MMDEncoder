#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "../src/messages.h"
#include "../src/platform.h"
#include <cstdio>

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  std::string raw; Json config;
  if (!readFile(argv[1], raw) || !JsonReader(raw).parse(config)) return 3;
  PluginMessages messages(config);
  Json params; params.type = Json::Object;
  params.o[L"seconds"].type = Json::Number; params.o[L"seconds"].n = 2.2;
  Json unknown; unknown.type = Json::Object;
  unknown.o[L"code"].type = Json::String; unknown.o[L"code"].s = L"FUTURE_NATIVE";
  unknown.o[L"params"] = params;
  std::printf("{\"title\":%s,\"brief\":%s,\"unknown\":%s}\n",
    jsonString(messages.text(L"plugin.title")).c_str(),
    jsonString(messages.format(L"plugin.testPassedShort", params)).c_str(),
    jsonString(messages.result(unknown, L"error.", L"external fallback {raw}")).c_str());
  return 0;
}
