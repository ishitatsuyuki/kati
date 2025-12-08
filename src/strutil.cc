// Copyright 2015 Google Inc. All rights reserved
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// +build ignore

#include "strutil.h"

#include <ctype.h>
#include <limits.h>
#include <unistd.h>

#include <algorithm>
#include <functional>
#include <stack>
#include <utility>

#ifdef __SSE2__
#include <emmintrin.h>
#endif

#include "log.h"

static bool isSpace(char c) {
  return (9 <= c && c <= 13) || c == 32;
}

CharMatcher::CharMatcher(const char* data, size_t len, const char* delimiters)
    : data_(data),
      len_(len),
      pos_(0),
      block_start_(~size_t{0}),
      matches_(0),
      delimiters_(delimiters) {}

void CharMatcher::UpdateBlockScalar() {
  block_start_ = pos_ & ~size_t{63};
  matches_ = 0;

  size_t end = std::min(block_start_ + 64, len_);
  for (size_t i = block_start_; i < end; ++i) {
    char c = data_[i];
    // Match null terminator implicitly (like strcspn)
    if (c == '\0') {
      matches_ |= (uint64_t{1} << (i - block_start_));
      continue;
    }
    for (const char* d = delimiters_; *d; ++d) {
      if (c == *d) {
        matches_ |= (uint64_t{1} << (i - block_start_));
        break;
      }
    }
  }
}

#ifdef __SSE2__
void CharMatcher::UpdateBlockSSE() {
  block_start_ = pos_ & ~size_t{63};
  matches_ = 0;

  // Load null terminator check vector
  __m128i zero = _mm_setzero_si128();

  // Process 4 x 16-byte chunks
  for (int chunk = 0; chunk < 4; ++chunk) {
    __m128i data = _mm_loadu_si128(
        reinterpret_cast<const __m128i*>(data_ + block_start_ + chunk * 16));

    // Start with null terminator matches
    __m128i result = _mm_cmpeq_epi8(data, zero);

    // Compare against each delimiter
    for (const char* d = delimiters_; *d; ++d) {
      __m128i delim = _mm_set1_epi8(*d);
      __m128i cmp = _mm_cmpeq_epi8(data, delim);
      result = _mm_or_si128(result, cmp);
    }

    // Convert to 16-bit mask and insert into 64-bit result
    int mask = _mm_movemask_epi8(result);
    matches_ |= static_cast<uint64_t>(static_cast<uint16_t>(mask))
                << (chunk * 16);
  }
}
#endif

void CharMatcher::UpdateBlock() {
#ifdef __SSE2__
  // Only use SSE for full 64-byte blocks that don't exceed buffer
  size_t new_block_start = pos_ & ~size_t{63};
  if (new_block_start + 64 <= len_) {
    UpdateBlockSSE();
    return;
  }
#endif
  UpdateBlockScalar();
}

size_t CharMatcher::SkipUntil() {
  size_t start_pos = pos_;
  while (pos_ < len_) {
    // Check if we need to update the block
    if (pos_ < block_start_ || pos_ >= block_start_ + 64) {
      UpdateBlock();
    }

    // Mask out bits before current position within block
    size_t offset = pos_ - block_start_;
    uint64_t remaining = matches_ >> offset;

    if (remaining) {
      size_t next = __builtin_ctzll(remaining);
      return pos_ - start_pos + next;
    }

    // No match in this block, move to next
    pos_ = block_start_ + 64;
  }
  return len_ - start_pos;
}

void CharMatcher::Advance(size_t n) {
  pos_ += n;
}

WordScanner::Iterator& WordScanner::Iterator::operator++() {
  int len = static_cast<int>(in->size());
  for (s = i + 1; s < len; s++) {
    if (!isSpace((*in)[s]))
      break;
  }
  if (s >= len) {
    in = NULL;
    s = 0;
    i = 0;
    return *this;
  }

  // skip until the next whitespace character
  CharMatcher matcher(in->data() + s, len - s, "\x09\x0a\x0b\x0c\x0d ");
  i = s + matcher.SkipUntil();
  return *this;
}

std::string_view WordScanner::Iterator::operator*() const {
  return in->substr(s, i - s);
}

WordScanner::WordScanner(std::string_view in) : in_(in) {}

WordScanner::Iterator WordScanner::begin() const {
  Iterator iter;
  iter.in = &in_;
  iter.s = 0;
  iter.i = -1;
  ++iter;
  return iter;
}

WordScanner::Iterator WordScanner::end() const {
  Iterator iter;
  iter.in = NULL;
  iter.s = 0;
  iter.i = 0;
  return iter;
}

void WordScanner::Split(std::vector<std::string_view>* o) {
  for (std::string_view t : *this)
    o->push_back(t);
}

WordWriter::WordWriter(std::string* o) : out_(o), needs_space_(false) {}

void WordWriter::MaybeAddSeparator(std::string_view sep) {
  if (needs_space_) {
    out_->append(sep);
  } else {
    needs_space_ = true;
  }
}

void WordWriter::Write(std::string_view s) {
  MaybeAddSeparator();
  out_->append(s);
}

ScopedTerminator::ScopedTerminator(std::string_view s)
    : s_(s), c_(s[s.size()]) {
  const_cast<char*>(s_.data())[s_.size()] = '\0';
}

ScopedTerminator::~ScopedTerminator() {
  const_cast<char*>(s_.data())[s_.size()] = c_;
}

bool HasPrefix(std::string_view str, std::string_view prefix) {
  ssize_t size_diff = str.size() - prefix.size();
  return size_diff >= 0 && str.substr(0, prefix.size()) == prefix;
}

bool HasPathPrefix(std::string_view str, std::string_view prefix) {
  return HasPrefix(str, prefix) &&
         (str.size() == prefix.size() || str.at(prefix.size()) == '/');
}

bool HasSuffix(std::string_view str, std::string_view suffix) {
  ssize_t size_diff = str.size() - suffix.size();
  return size_diff >= 0 && str.substr(size_diff) == suffix;
}

bool HasWord(std::string_view str, std::string_view w) {
  size_t found = str.find(w);
  if (found == std::string::npos)
    return false;
  if (found != 0 && !isSpace(str[found - 1]))
    return false;
  size_t end = found + w.size();
  if (end != str.size() && !isSpace(str[end]))
    return false;
  return true;
}

std::string_view TrimPrefix(std::string_view str, std::string_view prefix) {
  ssize_t size_diff = str.size() - prefix.size();
  if (size_diff < 0 || str.substr(0, prefix.size()) != prefix)
    return str;
  return str.substr(prefix.size());
}

std::string_view TrimSuffix(std::string_view str, std::string_view suffix) {
  ssize_t size_diff = str.size() - suffix.size();
  if (size_diff < 0 || str.substr(size_diff) != suffix)
    return str;
  return str.substr(0, size_diff);
}

Pattern::Pattern(std::string_view pat)
    : pat_(pat), percent_index_(pat.find('%')) {}

bool Pattern::Match(std::string_view str) const {
  if (percent_index_ == std::string::npos)
    return str == pat_;
  return MatchImpl(str);
}

bool Pattern::MatchImpl(std::string_view str) const {
  return (HasPrefix(str, pat_.substr(0, percent_index_)) &&
          HasSuffix(str, pat_.substr(percent_index_ + 1)));
}

std::string_view Pattern::Stem(std::string_view str) const {
  if (!Match(str))
    return "";
  return str.substr(percent_index_, str.size() - pat_.size() + 1);
}

void Pattern::AppendSubst(std::string_view str,
                          std::string_view subst,
                          std::string* out) const {
  if (percent_index_ == std::string::npos) {
    if (str == pat_) {
      out->append(subst);
      return;
    } else {
      out->append(str);
      return;
    }
  }

  if (MatchImpl(str)) {
    size_t subst_percent_index = subst.find('%');
    if (subst_percent_index == std::string::npos) {
      out->append(subst);
      return;
    } else {
      out->append(subst.substr(0, subst_percent_index));
      out->append(str.substr(percent_index_, str.size() - pat_.size() + 1));
      out->append(subst.substr(subst_percent_index + 1));
      return;
    }
  }
  out->append(str);
}

void Pattern::AppendSubstRef(std::string_view str,
                             std::string_view subst,
                             std::string* out) const {
  if (percent_index_ != std::string::npos &&
      subst.find('%') != std::string::npos) {
    AppendSubst(str, subst, out);
    return;
  }
  std::string_view s = TrimSuffix(str, pat_);
  out->append(s.begin(), s.end());
  out->append(subst.begin(), subst.end());
}

std::string NoLineBreak(const std::string& s) {
  size_t index = s.find('\n');
  if (index == std::string::npos)
    return s;
  std::string r = s;
  while (index != std::string::npos) {
    r = r.substr(0, index) + "\\n" + r.substr(index + 1);
    index = r.find('\n', index + 2);
  }
  return r;
}

std::string_view TrimLeftSpace(std::string_view s) {
  size_t i = 0;
  for (; i < s.size(); i++) {
    if (isSpace(s[i]))
      continue;
    char n = i + 1 < s.size() ? s[i + 1] : 0;
    if (s[i] == '\\' && (n == '\r' || n == '\n')) {
      i++;
      continue;
    }
    break;
  }
  return s.substr(i, s.size() - i);
}

std::string_view TrimRightSpace(std::string_view s) {
  size_t i = 0;
  for (; i < s.size(); i++) {
    char c = s[s.size() - 1 - i];
    if (isSpace(c)) {
      if ((c == '\r' || c == '\n') && s.size() >= i + 2 &&
          s[s.size() - 2 - i] == '\\')
        i++;
      continue;
    }
    break;
  }
  return s.substr(0, s.size() - i);
}

std::string_view TrimSpace(std::string_view s) {
  return TrimRightSpace(TrimLeftSpace(s));
}

std::string_view Dirname(std::string_view s) {
  size_t found = s.rfind('/');
  if (found == std::string::npos)
    return std::string_view(".");
  if (found == 0)
    return std::string_view("");
  return s.substr(0, found);
}

std::string_view Basename(std::string_view s) {
  size_t found = s.rfind('/');
  if (found == std::string::npos || found == 0)
    return s;
  return s.substr(found + 1);
}

std::string_view GetExt(std::string_view s) {
  size_t found = s.rfind('.');
  if (found == std::string::npos)
    return std::string_view("");
  return s.substr(found);
}

std::string_view StripExt(std::string_view s) {
  size_t slash_index = s.rfind('/');
  size_t found = s.rfind('.');
  if (found == std::string::npos ||
      (slash_index != std::string::npos && found < slash_index))
    return s;
  return s.substr(0, found);
}

void NormalizePath(std::string* o) {
  if (o->empty())
    return;
  size_t start_index = 0;
  if ((*o)[0] == '/')
    start_index++;
  size_t j = start_index;
  size_t prev_start = start_index;
  for (size_t i = start_index; i <= o->size(); i++) {
    char c = (*o)[i];
    if (c != '/' && c != 0) {
      (*o)[j] = c;
      j++;
      continue;
    }

    std::string_view prev_dir =
        std::string_view(o->data() + prev_start, j - prev_start);
    if (prev_dir == ".") {
      j--;
    } else if (prev_dir == ".." && j != 2 /* .. */) {
      if (j == 3) {
        // /..
        j = start_index;
      } else {
        size_t orig_j = j;
        j -= 4;
        j = o->rfind('/', j);
        if (j == std::string::npos) {
          j = start_index;
        } else {
          j++;
        }
        if (std::string_view(o->data() + j, 3) == "../") {
          j = orig_j;
          (*o)[j] = c;
          j++;
        }
      }
    } else if (!prev_dir.empty()) {
      if (c) {
        (*o)[j] = c;
        j++;
      }
    }
    prev_start = j;
  }
  if (j > 1 && (*o)[j - 1] == '/')
    j--;
  o->resize(j);
}

void AbsPath(std::string_view s, std::string* o) {
  if (!s.empty() && s.front() == '/') {
    o->clear();
  } else {
    char buf[PATH_MAX];
    if (!getcwd(buf, PATH_MAX)) {
      fprintf(stderr, "getcwd failed\n");
      CHECK(false);
    }

    CHECK(buf[0] == '/');
    *o = buf;
    *o += '/';
  }
  o->append(s);
  NormalizePath(o);
}

template <typename Cond>
size_t FindOutsideParenImpl(std::string_view s, Cond cond) {
  bool prev_backslash = false;
  std::stack<char> paren_stack;
  for (size_t i = 0; i < s.size(); i++) {
    char c = s[i];
    if (cond(c) && paren_stack.empty() && !prev_backslash) {
      return i;
    }
    switch (c) {
      case '(':
        paren_stack.push(')');
        break;
      case '{':
        paren_stack.push('}');
        break;

      case ')':
      case '}':
        if (!paren_stack.empty() && c == paren_stack.top()) {
          paren_stack.pop();
        }
        break;
    }
    prev_backslash = c == '\\' && !prev_backslash;
  }
  return std::string::npos;
}

size_t FindOutsideParen(std::string_view s, char c) {
  return FindOutsideParenImpl(s, [&c](char d) { return c == d; });
}

size_t FindTwoOutsideParen(std::string_view s, char c1, char c2) {
  return FindOutsideParenImpl(
      s, [&c1, &c2](char d) { return d == c1 || d == c2; });
}

size_t FindThreeOutsideParen(std::string_view s, char c1, char c2, char c3) {
  return FindOutsideParenImpl(
      s, [&c1, &c2, &c3](char d) { return d == c1 || d == c2 || d == c3; });
}

size_t FindEndOfLine(std::string_view s, size_t e, size_t* lf_cnt) {
  CharMatcher matcher(s.data() + e, s.size() - e, "\n\\");
  while (!matcher.AtEnd()) {
    size_t skip = matcher.SkipUntil();
    matcher.Advance(skip);
    e += skip;
    if (e >= s.size()) {
      CHECK(s.size() == e);
      break;
    }
    char c = s[e];
    if (c == '\0')
      break;
    if (c == '\\') {
      if (s[e + 1] == '\n') {
        e += 2;
        matcher.Advance(2);
        ++*lf_cnt;
      } else if (s[e + 1] == '\r' && s[e + 2] == '\n') {
        e += 3;
        matcher.Advance(3);
        ++*lf_cnt;
      } else if (s[e + 1] == '\\') {
        e += 2;
        matcher.Advance(2);
      } else {
        e++;
        matcher.Advance(1);
      }
    } else if (c == '\n') {
      ++*lf_cnt;
      return e;
    }
  }
  return e;
}

std::string_view TrimLeadingCurdir(std::string_view s) {
  while (s.substr(0, 2) == "./")
    s = s.substr(2);
  return s;
}

void FormatForCommandSubstitution(std::string* s) {
  while ((*s)[s->size() - 1] == '\n')
    s->pop_back();
  for (size_t i = 0; i < s->size(); i++) {
    if ((*s)[i] == '\n')
      (*s)[i] = ' ';
  }
}

std::string SortWordsInString(std::string_view s) {
  std::vector<std::string> toks;
  for (std::string_view tok : WordScanner(s)) {
    toks.push_back(std::string(tok));
  }
  sort(toks.begin(), toks.end());
  return JoinStrings(toks, " ");
}

std::string ConcatDir(std::string_view b, std::string_view n) {
  std::string r;
  if (!b.empty() && (n.empty() || n[0] != '/')) {
    r.append(b);
    r += '/';
  }
  r.append(n);
  NormalizePath(&r);
  return r;
}

std::string EchoEscape(const std::string& str) {
  const char* in = str.c_str();
  std::string buf;
  for (; *in; in++) {
    switch (*in) {
      case '\\':
        buf += "\\\\\\\\";
        break;
      case '\n':
        buf += "\\n";
        break;
      case '"':
        buf += "\\\"";
        break;
      default:
        buf += *in;
    }
  }
  return buf;
}

void EscapeShell(std::string* s) {
  static const char delimiters[] = "\"$\\`";
  CharMatcher matcher(s->c_str(), s->size(), delimiters);
  size_t prev = 0;
  size_t i = matcher.SkipUntil();
  matcher.Advance(i);
  if (i == s->size())
    return;

  std::string r;
  for (; i < s->size();) {
    r.append(std::string_view(*s).substr(prev, i - prev));
    char c = (*s)[i];
    r += '\\';
    if (c == '$') {
      if ((*s)[i + 1] == '$') {
        r += '$';
        i++;
        matcher.Advance(1);
      }
    }
    r += c;
    i++;
    matcher.Advance(1);
    prev = i;
    size_t skip = matcher.SkipUntil();
    i += skip;
    matcher.Advance(skip);
  }
  r.append(std::string_view(*s).substr(prev));
  s->swap(r);
}

bool IsInteger(std::string_view s) {
  if (s.size() == 0) {
    return false;
  }
  for (auto c : s) {
    if (c < '0' || c > '9') {
      return false;
    }
  }
  return true;
}
