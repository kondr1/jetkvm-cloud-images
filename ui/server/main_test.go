package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

const apiURL = "https://jett.example.com"

var bigJS = "fetch(\"" + placeholder + "/me\");" + strings.Repeat("console.log(1);", 200)

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":                    {Data: []byte(`<script>window.api="` + placeholder + `"</script>`)},
		"assets/immutable/app-abc.js":   {Data: []byte(bigJS)},
		"assets/immutable/font-1.woff2": {Data: []byte{0, 1, 2}},
		"favicon.ico":                   {Data: []byte{3, 4}},
	}
}

func newSite(t *testing.T) *site {
	t.Helper()
	s, err := load(testFS(), apiURL)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func get(t *testing.T, s *site, target string, headers map[string]string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec.Result()
}

func body(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestPlaceholderReplaced(t *testing.T) {
	s := newSite(t)
	for _, target := range []string{"/", "/assets/immutable/app-abc.js"} {
		got := body(t, get(t, s, target, nil))
		if strings.Contains(got, placeholder) || !strings.Contains(got, apiURL) {
			t.Errorf("%s: placeholder not replaced: %.80q", target, got)
		}
	}
}

func TestSPAFallback(t *testing.T) {
	s := newSite(t)
	resp := get(t, s, "/devices/abc123", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("content type %q", ct)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("cache control %q", cc)
	}
	if !strings.Contains(body(t, resp), apiURL) {
		t.Error("fallback is not index.html")
	}
}

func TestMissingFileIs404(t *testing.T) {
	s := newSite(t)
	if resp := get(t, s, "/assets/immutable/gone-123.js", nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestCacheHeaders(t *testing.T) {
	s := newSite(t)
	resp := get(t, s, "/assets/immutable/font-1.woff2", nil)
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("cache control %q", cc)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "font/woff2" {
		t.Errorf("content type %q", ct)
	}
	if cc := get(t, s, "/favicon.ico", nil).Header.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("favicon cache control %q", cc)
	}
}

func TestGzip(t *testing.T) {
	s := newSite(t)
	resp := get(t, s, "/assets/immutable/app-abc.js", map[string]string{"Accept-Encoding": "gzip, br"})
	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatal("not gzipped")
	}
	zr, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := io.ReadAll(zr)
	if !bytes.Contains(plain, []byte(apiURL)) {
		t.Error("gzipped body lacks the substituted URL")
	}

	if get(t, s, "/assets/immutable/app-abc.js", nil).Header.Get("Content-Encoding") != "" {
		t.Error("gzipped without Accept-Encoding")
	}
}

func TestETag(t *testing.T) {
	s := newSite(t)
	etag := get(t, s, "/", nil).Header.Get("ETag")
	if etag == "" {
		t.Fatal("no ETag")
	}
	if resp := get(t, s, "/", map[string]string{"If-None-Match": etag}); resp.StatusCode != http.StatusNotModified {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	s := newSite(t)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestHead(t *testing.T) {
	s := newSite(t)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, "/", nil))
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("status %d, body %d bytes", rec.Code, rec.Body.Len())
	}
}

func TestLoadRequiresPlaceholder(t *testing.T) {
	fsys := fstest.MapFS{"index.html": {Data: []byte("<p>built with a hardcoded API</p>")}}
	if _, err := load(fsys, apiURL); err == nil {
		t.Fatal("expected an error without any placeholder")
	}
}

func TestLoadRequiresIndex(t *testing.T) {
	fsys := fstest.MapFS{"app.js": {Data: []byte(placeholder)}}
	if _, err := load(fsys, apiURL); err == nil {
		t.Fatal("expected an error without index.html")
	}
}

func TestNormalizeAPIURL(t *testing.T) {
	cases := map[string]string{
		"https://jett.example.com/":  "https://jett.example.com",
		" https://jett.example.com ": "https://jett.example.com",
		"http://localhost:3000":      "http://localhost:3000",
		"https://example.com/api/":   "https://example.com/api",
	}
	for in, want := range cases {
		got, err := normalizeAPIURL(in)
		if err != nil || got != want {
			t.Errorf("normalizeAPIURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "jett.example.com", "ftp://x", "https://", "https://x/?a=1"} {
		if _, err := normalizeAPIURL(bad); err == nil {
			t.Errorf("normalizeAPIURL(%q): expected an error", bad)
		}
	}
}
