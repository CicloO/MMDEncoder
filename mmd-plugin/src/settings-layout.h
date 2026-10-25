#pragma once
#include <windows.h>
#include <string>
#include <vector>

// Measure the existing controls with their actual dialog font. Retain the
// Chinese geometry unless longer copy needs more room; never shrink type.
void fitSettingsLayout(HWND dialog, const std::vector<std::wstring>& testLabels);
