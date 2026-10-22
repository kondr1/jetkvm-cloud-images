// Command jetkvm-cloud-ui serves the JetKVM cloud UI, embedded at build time.
//
// The UI is built with VITE_CLOUD_API set to a placeholder, which is replaced
// in memory at startup with JETKVM_CLOUD_API. One image therefore serves any
// deployment, and the API origin is plain runtime configuration.
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"strings"
	"syscall"
	"time"
)

//go:embed all:dist
var embedded embed.FS

// placeholder is the VITE_CLOUD_API value the UI is built with.
const placeholder = "__JETKVM_CLOUD_API__"

// immutablePrefix holds content-hashed files, see build.rolldownOptions in the UI's vite.config.ts.
const immutablePrefix = "assets/immutable/"

// Text files are the only ones that can carry the placeholder, and the only ones worth compressing.
var textExtensions = map[string]bool{
	".html": true, ".js": true, ".mjs": true, ".css": true, ".json": true,
	".map": true, ".txt": true, ".svg": true, ".webmanifest": true, ".xml": true,
}

// A scratch image has no /etc/mime.types, so cover what Go's built-in table lacks.
var extraTypes = map[string]string{
	".woff2":       "font/woff2",
	".woff":        "font/woff",
	".ttf":         "font/ttf",
	".ico":         "image/x-icon",
	".map":         "application/json",
	".txt":         "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".xml":         "text/xml; charset=utf-8",
}

type asset struct {
	body        []byte
	gzipped     []byte // nil when compression does not pay off
	contentType string
	etag        string
}

type site struct {
	assets map[string]*asset
	index  *asset
}

// normalizeAPIURL validates the API origin and strips a trailing slash, since the UI appends paths to it.
func normalizeAPIURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("parse %q: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("%q: scheme must be http or https", raw)
	}
	if u.Host == "" {
		return "", fmt.Errorf("%q: missing host", raw)
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%q: must not have a query or fragment", raw)
	}
	return strings.TrimSuffix(u.String(), "/"), nil
}

func contentType(name string) string {
	ext := path.Ext(name)
	if t, ok := extraTypes[ext]; ok {
		return t
	}
	if t := mime.TypeByExtension(ext); t != "" {
		return t
	}
	return "application/octet-stream"
}

func gzipBytes(b []byte) []byte {
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	zw.Write(b)
	zw.Close()
	if buf.Len() >= len(b) {
		return nil
	}
	return buf.Bytes()
}

// load reads every file of fsys into memory with the placeholder replaced by apiURL.
func load(fsys fs.FS, apiURL string) (*site, error) {
	s := &site{assets: map[string]*asset{}}
	replaced := 0

	err := fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return err
		}

		a := &asset{contentType: contentType(name)}
		if textExtensions[path.Ext(name)] {
			if n := bytes.Count(body, []byte(placeholder)); n > 0 {
				body = bytes.ReplaceAll(body, []byte(placeholder), []byte(apiURL))
				replaced += n
			}
			if len(body) > 1024 {
				a.gzipped = gzipBytes(body)
			}
		}
		sum := sha256.Sum256(body)
		a.body = body
		a.etag = `"` + hex.EncodeToString(sum[:8]) + `"`
		s.assets[name] = a
		return nil
	})
	if err != nil {
		return nil, err
	}

	s.index = s.assets["index.html"]
	if s.index == nil {
		return nil, errors.New("index.html not found")
	}
	// Without a single substitution the UI would call a literal placeholder host.
	if replaced == 0 {
		return nil, fmt.Errorf("placeholder %s not found in any text file", placeholder)
	}
	return s, nil
}

func (s *site) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}

	a := s.assets[name]
	if a == nil {
		// Client-side routes (/devices/abc) have no extension and get the SPA shell;
		// a missing file is a real 404, so a stale chunk fails loudly instead of parsing HTML as JS.
		if path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
		a, name = s.index, "index.html"
	}

	h := w.Header()
	h.Set("Content-Type", a.contentType)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("ETag", a.etag)
	h.Set("Vary", "Accept-Encoding")
	if strings.HasPrefix(name, immutablePrefix) {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "no-cache")
	}

	if r.Header.Get("If-None-Match") == a.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	body := a.body
	if a.gzipped != nil && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		h.Set("Content-Encoding", "gzip")
		body = a.gzipped
	}
	h.Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		w.Write(body)
	}
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	healthcheck := flag.Bool("healthcheck", false, "probe the server on -addr and exit; for container health checks")
	flag.Parse()

	if *healthcheck {
		port := (*addr)[strings.LastIndex(*addr, ":"):]
		client := http.Client{Timeout: 3 * time.Second}
		resp, err := client.Get("http://127.0.0.1" + port + "/")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}

	apiURL, err := normalizeAPIURL(os.Getenv("JETKVM_CLOUD_API"))
	if err != nil {
		log.Fatalf("JETKVM_CLOUD_API: %v", err)
	}
	dist, err := fs.Sub(embedded, "dist")
	if err != nil {
		log.Fatal(err)
	}
	s, err := load(dist, apiURL)
	if err != nil {
		log.Fatal(err)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	log.Printf("serving %d files on %s, API %s", len(s.assets), *addr, apiURL)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
