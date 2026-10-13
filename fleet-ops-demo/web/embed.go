// Package web holds the page: index.html, app.js and styles.css, built into the server binary.
package web

import "embed"

//go:embed index.html app.js styles.css
var Files embed.FS
