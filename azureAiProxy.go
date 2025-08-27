package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
)

var (
	azureEndpoint  = getenv("AZURE_API_ENDPOINT", "<YOUR_DEPLOYMENT_ENDPOINT_URL>") // e.g., https://...cognitiveservices.azure.com/openai/deployments/o3-mini
	azureAPIVer    = getenv("AZURE_API_VERSION", "2025-01-01-preview")
	azureAPIKey    = getenv("AZURE_API_KEY", "<YOUR_API_KEY>")
	port           = getenv("PORT", "8000")
)

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	http.HandleFunc("/", handle)
	log.Printf("Starting Azure OpenAI proxy server on port %s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusMethodNotAllowed)
		_, _ = w.Write([]byte("Method Not Allowed"))
		return
	}

	// 1) Read JSON body from client (e.g., Zed)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var zedPayload map[string]any
	if err := json.Unmarshal(body, &zedPayload); err != nil {
		http.Error(w, "Invalid JSON from client", http.StatusBadRequest)
		return
	}

	// 2) Transform the request for Azure OpenAI
	azurePayload := transformRequest(zedPayload)
	payloadBytes, err := json.Marshal(azurePayload)
	if err != nil {
		http.Error(w, "Failed to marshal transformed payload", http.StatusInternalServerError)
		return
	}

	// 3) Forward the request to Azure OpenAI (streaming SSE)
	azureURL := fmt.Sprintf("%s/chat/completions?api-version=%s", azureEndpoint, azureAPIVer)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, azureURL, bytes.NewReader(payloadBytes))
	if err != nil {
		http.Error(w, "Failed to create upstream request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("api-key", azureAPIKey)
	req.Header.Set("user-agent", "Zed/0.178.5")

	client := &http.Client{} // No timeout for streaming; relies on context cancellation

	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, fmt.Sprintf("Error communicating with Azure OpenAI: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		errText, _ := io.ReadAll(resp.Body)
		http.Error(
			w,
			fmt.Sprintf("Error communicating with Azure OpenAI: %d %s\n%s", resp.StatusCode, resp.Status, string(errText)),
			http.StatusBadGateway,
		)
		return
	}

	// Set SSE headers to client
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	flusher, _ := w.(http.Flusher)

	// Stream and filter the Azure OpenAI response to the client
	reader := bufio.NewReader(resp.Body)

	for {
		// Read a single SSE line (terminated by '\n')
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			trimmed := strings.TrimRight(line, "\r\n")

			// Preserve blank lines to maintain event boundaries
			if trimmed == "" {
				_, _ = w.Write([]byte("\n"))
				if flusher != nil {
					flusher.Flush()
				}
				if err == io.EOF {
					break
				}
				continue
			}

			if strings.HasPrefix(trimmed, "data:") {
				after := strings.TrimSpace(trimmed[len("data:"):])

				// Forward the DONE signal
				if after == "[DONE]" {
					_, _ = io.WriteString(w, "data: [DONE]\n\n")
					if flusher != nil {
						flusher.Flush()
					}
					if err == io.EOF {
						break
					}
					continue
				}

				if strings.TrimSpace(after) == "" {
					// Skip empty data events (e.g., "data: ")
					if err == io.EOF {
						break
					}
					continue
				}

				// Try to parse JSON payload to filter choices: []
				jsonStr := strings.TrimLeft(trimmed[len("data:"):], " ")
				var payload map[string]any
				if uerr := json.Unmarshal([]byte(jsonStr), &payload); uerr == nil {
					if choices, ok := payload["choices"].([]any); ok && len(choices) == 0 {
						// Skip empty choices
						if err == io.EOF {
							break
						}
						continue
					}
					// Forward original line
					_, _ = io.WriteString(w, trimmed+"\n")
				} else {
					// Non-JSON or unexpected — forward as-is
					_, _ = io.WriteString(w, trimmed+"\n")
				}
			} else {
				// Forward non-data lines (comments, etc.)
				_, _ = io.WriteString(w, trimmed+"\n")
			}

			if flusher != nil {
				flusher.Flush()
			}
		}

		if err != nil {
			if err != io.EOF {
				log.Printf("Error during streaming to client: %v", err)
			}
			break
		}
	}
}

func transformRequest(zed map[string]any) map[string]any {
	systemMessage := map[string]any{
		"role":    "system",
		"content": "You must always respond in markdown format.",
	}

	// If a simple 'prompt' is provided, build messages array with system first
	if prompt, ok := zed["prompt"]; ok {
		messages := []any{
			systemMessage,
			map[string]any{"role": "user", "content": fmt.Sprintf("%v", prompt)},
		}

		azure := map[string]any{
			"messages":    messages,
			"temperature": 0.7,
			"max_tokens":  200,
			"stream":      true,
		}

		// Merge the rest of zed (minus 'prompt') to allow overrides
		for k, v := range zed {
			if k == "prompt" {
				continue
			}
			azure[k] = v
		}
		return azure
	}

	// Otherwise, copy payload and ensure streaming + system message prepended
	azure := make(map[string]any, len(zed)+2)
	for k, v := range zed {
		azure[k] = v
	}
	azure["stream"] = true

	if msgs, ok := azure["messages"]; ok {
		if msgSlice, ok := msgs.([]any); ok {
			azure["messages"] = append([]any{systemMessage}, msgSlice...)
		} else {
			azure["messages"] = []any{systemMessage}
		}
	} else {
		azure["messages"] = []any{systemMessage}
	}
	return azure
}
