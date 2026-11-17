import os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
import http.server, socketserver
PORT = int(os.environ.get('PORT', 8000))
handler = http.server.SimpleHTTPRequestHandler

# Threaded, not plain TCPServer: the app requests ten-plus scripts in parallel on boot,
# and a single-threaded server serialises them. Under the service worker's network-first
# fetch the slow ones time out and come back as its synthetic 503 "Offline", so a random
# subset of scripts silently fails to execute and the app half-loads. That looks exactly
# like a code error and is not one.
class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

with Server(("127.0.0.1", PORT), handler) as httpd:
    print(f"Serving at http://127.0.0.1:{PORT}")
    httpd.serve_forever()
