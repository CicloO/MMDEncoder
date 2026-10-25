#pragma once
#include <map>
#include <string>
#include <vector>

struct Json {
  enum Type { Null, Bool, Number, String, Array, Object } type = Null;
  bool b = false;
  double n = 0;
  std::wstring s;
  std::vector<Json> a;
  std::map<std::wstring, Json> o;
  const Json& operator[](const wchar_t* key) const;
};

class JsonReader {
 public:
  explicit JsonReader(const std::string& text);
  bool parse(Json& out);
 private:
  void ws();
  char peek();
  void expect(char c);
  Json value();
  std::wstring string();
  const std::string& t_;
  size_t i_ = 0;
};

std::string jsonString(const std::wstring& w);
