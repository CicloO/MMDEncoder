#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "json.h"
#include "platform.h"
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>

const Json& Json::operator[](const wchar_t* key) const {
  static const Json none;
  auto it = o.find(key);
  return it == o.end() ? none : it->second;
}

JsonReader::JsonReader(const std::string& text) : t_(text) {}
bool JsonReader::parse(Json& out) {
  try {
    out = value();
    return true;
  } catch (...) {
    return false;
  }
}

void JsonReader::ws() {
  while (i_ < t_.size() && isspace((unsigned char)t_[i_])) i_++;
}
char JsonReader::peek() {
  ws();
  if (i_ >= t_.size()) throw 0;
  return t_[i_];
}
void JsonReader::expect(char c) {
  if (peek() != c) throw 0;
  i_++;
}
Json JsonReader::value() {
  Json j;
  char c = peek();
  if (c == '{') {
    j.type = Json::Object;
    i_++;
    if (peek() == '}') return i_++, j;
    for (;;) {
      std::wstring key = string();
      expect(':');
      j.o[key] = value();
      if (peek() == ',') {
        i_++;
        continue;
      }
      expect('}');
      return j;
    }
  }
  if (c == '[') {
    j.type = Json::Array;
    i_++;
    if (peek() == ']') return i_++, j;
    for (;;) {
      j.a.push_back(value());
      if (peek() == ',') {
        i_++;
        continue;
      }
      expect(']');
      return j;
    }
  }
  if (c == '"') {
    j.type = Json::String;
    j.s = string();
    return j;
  }
  if (t_.compare(i_, 4, "true") == 0) return i_ += 4, j.type = Json::Bool, j.b = true, j;
  if (t_.compare(i_, 5, "false") == 0) return i_ += 5, j.type = Json::Bool, j;
  if (t_.compare(i_, 4, "null") == 0) return i_ += 4, j;
  size_t end = i_;
  while (end < t_.size() && strchr("+-0123456789.eE", t_[end])) end++;
  if (end == i_) throw 0;
  j.type = Json::Number;
  j.n = atof(t_.substr(i_, end - i_).c_str());
  i_ = end;
  return j;
}
std::wstring JsonReader::string() {
  expect('"');
  std::string bytes;
  while (i_ < t_.size() && t_[i_] != '"') {
    char c = t_[i_++];
    if (c != '\\') {
      bytes += c;
      continue;
    }
    char e = t_.at(i_++);
    switch (e) {
      case 'n': bytes += '\n'; break;
      case 't': bytes += '\t'; break;
      case 'r': bytes += '\r'; break;
      case 'b': bytes += '\b'; break;
      case 'f': bytes += '\f'; break;
      case 'u': {
        unsigned cp = std::stoul(t_.substr(i_, 4), nullptr, 16);
        i_ += 4;
        if (cp >= 0xD800 && cp < 0xDC00 && t_.compare(i_, 2, "\\u") == 0) {
          unsigned lo = std::stoul(t_.substr(i_ + 2, 4), nullptr, 16);
          i_ += 6;
          cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
        }
        std::wstring w;
        if (cp >= 0x10000) {
          w += (wchar_t)(0xD800 + ((cp - 0x10000) >> 10));
          w += (wchar_t)(0xDC00 + ((cp - 0x10000) & 0x3FF));
        } else {
          w += (wchar_t)cp;
        }
        bytes += utf8(w);
        break;
      }
      default: bytes += e;
    }
  }
  expect('"');
  return utf16(bytes);
}

std::string jsonString(const std::wstring& w) {
  std::string out = "\"";
  for (unsigned char c : utf8(w)) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += (char)c;
    } else if (c < 0x20) {
      char buf[8];
      sprintf_s(buf, "\\u%04x", c);
      out += buf;
    } else {
      out += (char)c;
    }
  }
  return out + "\"";
}

