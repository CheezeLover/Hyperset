import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

req = urllib.request.Request("http://localhost/superset/welcome/")
req.add_header("Host", "superset.debian-with-git-podman.cluster.local")
req.add_header("X-Token-User-Email", "admin@HYPERSET.local")
req.add_header("X-Token-User-Id", "1")
req.add_header("X-Token-User-Roles", "hyperset/admin")

try:
    resp = urllib.request.urlopen(req, context=ctx)
    html = resp.read().decode('utf-8')
    print("bridge.js in HTML:", "bridge.js" in html)
    if "bridge.js" in html:
        idx = html.find("bridge.js")
        print("Snippet:", html[idx-30:idx+30])
    else:
        print("HTML length:", len(html))
        print("End of HTML:", html[-200:])
except Exception as e:
    print("Error:", e)
