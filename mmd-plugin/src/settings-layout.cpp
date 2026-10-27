#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "settings-layout.h"
#include <algorithm>
#include <vector>

static RECT childRect(HWND dialog, HWND child) {
  RECT r; GetWindowRect(child, &r); MapWindowPoints(nullptr, dialog, (POINT*)&r, 2); return r;
}
static int textWidth(HWND child, const std::wstring& text) {
  HDC dc = GetDC(child);
  auto old = SelectObject(dc, (HFONT)SendMessageW(child, WM_GETFONT, 0, 0));
  SIZE size{}; GetTextExtentPoint32W(dc, text.c_str(), (int)text.size(), &size);
  SelectObject(dc, old); ReleaseDC(child, dc); return size.cx;
}
static std::wstring windowText(HWND child) {
  std::wstring text(GetWindowTextLengthW(child) + 1, 0);
  int n = GetWindowTextW(child, text.data(), (int)text.size()); text.resize(n); return text;
}
static int comboHeight(HWND child, int fallback) {
  RECT dropped{};
  return SendMessageW(child, CB_GETDROPPEDCONTROLRECT, 0, (LPARAM)&dropped) ? dropped.bottom - dropped.top : fallback;
}
void fitSettingsLayout(HWND dialog, const std::vector<std::wstring>& testLabels) {
  RECT client; GetClientRect(dialog, &client);
  const int ids[] = {105, 107, IDOK, IDCANCEL};
  RECT first = childRect(dialog, GetDlgItem(dialog, 105));
  RECT second = childRect(dialog, GetDlgItem(dialog, 107));
  int margin = first.left, gap = second.left - first.right;
  std::vector<int> widths;
  int row = margin * 2 + gap * 3;
  for (int id : ids) {
    HWND control = GetDlgItem(dialog, id); RECT r = childRect(dialog, control);
    int width = std::max<int>(r.right - r.left, textWidth(control, windowText(control)) + 16);
    if (id == 107) for (const auto& label : testLabels) width = std::max(width, textWidth(control, label) + 16);
    widths.push_back(width); row += width;
  }
  int required = std::max<int>(client.right, row);
  for (int id : {102, 106}) {
    HWND control = GetDlgItem(dialog, id);
    required = std::max(required, margin * 2 + textWidth(control, windowText(control)) + 24);
  }
  int column = 0;
  for (int id : {103, 104}) {
    HWND control = GetDlgItem(dialog, id);
    for (int i = 0, count = (int)SendMessageW(control, CB_GETCOUNT, 0, 0); i < count; i++) {
      int n = (int)SendMessageW(control, CB_GETLBTEXTLEN, i, 0);
      std::wstring text(n + 1, 0); SendMessageW(control, CB_GETLBTEXT, i, (LPARAM)text.data()); text.resize(n);
      column = std::max(column, textWidth(control, text) + 30);
    }
  }
  for (int id : {109, 110, 115}) column = std::max(column, textWidth(GetDlgItem(dialog, id), windowText(GetDlgItem(dialog, id))));
  HWND shift = GetDlgItem(dialog, 111);
  RECT shiftRect = childRect(dialog, shift);
  const int editWidth = std::max<int>(shiftRect.right - shiftRect.left, textWidth(shift, L"-9007199254740991") + 12);
  column = std::max(column, editWidth);
  column = std::max(column, textWidth(GetDlgItem(dialog, 112), windowText(GetDlgItem(dialog, 112))) + 24);
  RECT mask = childRect(dialog, GetDlgItem(dialog, 104));
  RECT fade = childRect(dialog, GetDlgItem(dialog, 103));
  int middle = fade.left - mask.right;
  required = std::max(required, margin * 2 + middle + column * 2);
  int deltaWidth = required - client.right;
  HWND note = GetDlgItem(dialog, 108); RECT noteRect = childRect(dialog, note);
  int noteWidth = noteRect.right - noteRect.left + deltaWidth;
  HDC dc = GetDC(note); auto old = SelectObject(dc, (HFONT)SendMessageW(note, WM_GETFONT, 0, 0));
  RECT measured{0, 0, noteWidth, 0}; std::wstring noteText = windowText(note);
  DrawTextW(dc, noteText.c_str(), (int)noteText.size(), &measured, DT_CALCRECT | DT_WORDBREAK);
  SelectObject(dc, old); ReleaseDC(note, dc);
  int deltaHeight = std::max(0L, measured.bottom - (noteRect.bottom - noteRect.top));
  if (!deltaWidth && !deltaHeight) return;
  RECT outer; GetWindowRect(dialog, &outer);
  SetWindowPos(dialog, nullptr, 0, 0, outer.right - outer.left + deltaWidth, outer.bottom - outer.top + deltaHeight, SWP_NOMOVE | SWP_NOZORDER);
  int half = (required - margin * 2 - middle) / 2;
  for (int id : {101, 102, 106, 108}) {
    HWND child = GetDlgItem(dialog, id); RECT r = childRect(dialog, child);
    int height = id == 101 ? comboHeight(child, r.bottom - r.top) : r.bottom - r.top;
    SetWindowPos(child, nullptr, r.left, r.top, r.right - r.left + deltaWidth, height + (id == 108 ? deltaHeight : 0), SWP_NOZORDER);
  }
  for (int id : {104, 109, 103, 110}) {
    HWND child = GetDlgItem(dialog, id); RECT r = childRect(dialog, child);
    int height = (id == 103 || id == 104) ? comboHeight(child, r.bottom - r.top) : r.bottom - r.top;
    SetWindowPos(child, nullptr, (id == 103 || id == 110) ? margin + half + middle : margin, r.top, half, height, SWP_NOZORDER);
  }
  for (int id : {115, 112}) {
    HWND child = GetDlgItem(dialog, id); RECT r = childRect(dialog, child);
    SetWindowPos(child, nullptr, id == 112 ? margin + half + middle : margin, r.top, half, r.bottom - r.top, SWP_NOZORDER);
  }
  SetWindowPos(shift, nullptr, margin, shiftRect.top, half, shiftRect.bottom - shiftRect.top, SWP_NOZORDER);
  int x = margin;
  for (int i = 0; i < 4; i++) {
    HWND child = GetDlgItem(dialog, ids[i]); RECT r = childRect(dialog, child);
    SetWindowPos(child, nullptr, x, r.top + deltaHeight, widths[i], r.bottom - r.top, SWP_NOZORDER);
    x += widths[i] + gap;
  }
}
