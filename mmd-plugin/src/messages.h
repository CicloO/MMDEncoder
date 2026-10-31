#pragma once
#include "json.h"
#include <string>

// Immutable language snapshot for one native window / operation.
class PluginMessages {
 public:
  explicit PluginMessages(const Json& config = Json{});
  std::wstring text(const wchar_t* key) const;
  std::wstring format(const wchar_t* key, const Json& params, const std::wstring& fallback = L"") const;
  std::wstring result(const Json& data, const wchar_t* prefix, const std::wstring& fallback) const;
  std::wstring number(double value, int digits) const;
  // Dialog face for the snapshot's language: Japanese kanji in a Chinese face
  // read as Chinese glyph shapes.
  const wchar_t* font() const;
 private:
  std::wstring locale_;
  Json messages_;
};
