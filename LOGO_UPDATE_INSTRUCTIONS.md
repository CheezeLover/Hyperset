# 🎨 Custom Logo Update for Superset

## ✅ Changes Made

Your Hyperset logo will now appear in the Superset UI instead of the default Superset logo.

### Files Modified:

1. **`Superset-Instance/superset_config_docker.py`**
   - Added logo configuration settings
   - `LOGO_TARGET_PATH` - points to custom logo
   - `FAVICON_PATH` - points to custom favicon
   - `APP_ICON` - points to custom app icon
   - Disabled default banner

2. **`podman-compose.superset.yml`**
   - Added logo volume mount to `superset-app` container
   - Added logo volume mount to `superset-worker` container  
   - Added logo volume mount to `superset-beat` container
   - Added logo volume mount to `superset-init` container

3. **`portal-app/src/components/ServiceColumn.tsx`**
   - Removed the logo from the sidebar (not needed there)

### Logo File Location:
- **Source**: `logos/logo_hyperset.png`
- **Mounted in containers at**: `/app/pythonpath/custom_logo.png`

---

## 🚀 How to Apply Changes

### Step 1: Rebuild Superset Container

```bash
cd /path/to/Hyperset

# Rebuild the Superset image with new configuration
podman-compose -f podman-compose.superset.yml build superset-app

# Or rebuild all Superset services
podman-compose -f podman-compose.superset.yml build
```

### Step 2: Restart Superset Services

```bash
# Restart all Superset services to pick up the new logo
podman-compose -f podman-compose.superset.yml restart

# Or restart individually
podman-compose -f podman-compose.superset.yml restart superset-app
podman-compose -f podman-compose.superset.yml restart superset-worker
podman-compose -f podman-compose.superset.yml restart superset-beat
```

### Step 3: Clear Browser Cache

Superset caches static assets aggressively. You need to:

1. **Hard refresh** the Superset page: `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (Mac)
2. **Clear browser cache** for the Superset domain
3. **Open in incognito/private window** to test

### Step 4: Verify Logo Appears

Visit: `https://superset.your-domain.com`

The logo should appear in:
- ✅ Top navigation bar (left side)
- ✅ Browser tab favicon
- ✅ Login screen (if you logout)
- ✅ Any place the Superset logo normally appears

---

## 🔍 Troubleshooting

If the logo doesn't appear:

### Check 1: Verify logo file in container
```bash
podman exec hyperset-superset ls -la /app/pythonpath/custom_logo.png
```

Expected output: Should show the file with proper size (~765KB)

### Check 2: Check Superset logs
```bash
podman logs hyperset-superset --tail 50 | grep -i logo
```

Look for: `[Theme] Custom logo configured: /app/pythonpath/custom_logo.png`

### Check 3: Verify config loaded
```bash
podman exec hyperset-superset python -c "from superset import config; print('LOGO_TARGET_PATH:', config.get('LOGO_TARGET_PATH'))"
```

Should output: `LOGO_TARGET_PATH: /app/pythonpath/custom_logo.png`

### Check 4: Browser Network Tab
1. Open DevTools (F12)
2. Go to Network tab
3. Refresh page
4. Look for requests to logo files (search for "logo" or "custom_logo")
5. Check if it returns 200 OK or 404

---

## 📝 Important Notes

### Logo Size
Your current logo is **1024x768 pixels** and **765KB**. This is quite large for a logo. For better performance, consider:

```bash
# Optional: Create a smaller version (if you have ImageMagick installed)
convert logos/logo_hyperset.png -resize 200x150 logos/logo_hyperset_small.png
```

Then update the volume mounts to use `logo_hyperset_small.png` instead.

### Logo Format
Superset supports:
- PNG (recommended for transparency)
- SVG (scalable, but may not work in all contexts)
- JPG (no transparency)

### Browser Caching
Superset uses aggressive caching for static assets. If you update the logo again:
1. Change the filename (e.g., `logo_hyperset_v2.png`)
2. Or add a cache buster: `?v=2` to the URL

---

## 🎯 Expected Result

After restarting, when you visit Superset:
1. **Top navbar**: Should show your custom Hyperset logo instead of "Apache Superset"
2. **Browser tab**: Should show your logo as favicon
3. **Login page**: Should show your logo if you access the login screen

The logo will be **displayed at its original aspect ratio** (not stretched) because we're using `object-fit: contain` in CSS (if applied) or Superset's default logo sizing.

---

## 🔄 Rollback (If Needed)

If something goes wrong, revert the changes:

```bash
# Remove logo configuration from superset_config_docker.py
git checkout Superset-Instance/superset_config_docker.py

# Remove volume mounts from podman-compose.superset.yml
git checkout podman-compose.superset.yml

# Restart Superset
podman-compose -f podman-compose.superset.yml restart
```

---

## ✅ Success!

Your Hyperset branding is now fully integrated into Superset! The logo will appear throughout the Superset UI, providing a seamless branded experience for your users.
