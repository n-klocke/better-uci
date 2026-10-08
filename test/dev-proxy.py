# Dev proxy for the www pages: python3 test/dev-proxy.py [port], then open
# http://127.0.0.1:8766/home/<kino> or /film/... in any browser. Forwards to
# www.uci-kinowelt.de and puts the working copy of better-uci.user.js at the
# top of every HTML page's <head>, i.e. at document-start, with its hostname
# check pointed at 127.0.0.1. Paths match the real site, so page routing and
# the home page's programme fetch behave as there. No Tampermonkey needed.
# Not for buchung.uci-kinowelt.de (needs your session and cookies).
import http.server, urllib.request, urllib.error, sys, os
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'better-uci.user.js')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
UPSTREAM = 'https://www.uci-kinowelt.de'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith('/__bu.js'):
            body = open(SCRIPT, 'rb').read().replace(b"location.hostname === 'www.uci-kinowelt.de'", b"location.hostname === '127.0.0.1'")
            return self.reply(200, 'text/javascript', body)
        req = urllib.request.Request(UPSTREAM + self.path, headers={'User-Agent': UA, 'Accept-Encoding': 'identity',
            'Cookie': self.headers.get('Cookie', ''), 'Accept': self.headers.get('Accept', '*/*')})
        try:
            r = urllib.request.urlopen(req, timeout=30); code = r.status
        except urllib.error.HTTPError as e:
            r = e; code = e.code
        body = r.read(); ct = r.headers.get('Content-Type', 'application/octet-stream')
        if 'text/html' in ct:
            body = body.replace(b'<head>', b'<head><script src="/__bu.js"></script>', 1)
        self.reply(code, ct, body)
    def reply(self, code, ct, body):
        self.send_response(code); self.send_header('Content-Type', ct)
        self.send_header('Content-Length', str(len(body))); self.send_header('Cache-Control', 'no-store')
        self.end_headers(); self.wfile.write(body)
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
