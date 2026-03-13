# Theming & Branding Guide

Hyperset supports comprehensive theming through a single `theme.json` file that controls both the Hyperset Portal and Superset interfaces.

## Quick Start

1. **Edit `theme.json`** - Configure your colors and branding in the `palette` section
2. **Add logos to `logos/`** - Place your custom SVG/PNG files
3. **Restart** - Run `./setup_podman.sh` to apply

## Configuration

### `theme.json` Structure (Simplified v2)

The theme uses a unified palette structure where colors are defined once with light/dark variants:

```json
{
  "name": "Your Theme Name",
  "palette": {
    "primary": {
      "base": "#D35400",
      "dark": "#A04000",
      "light": "#E67E22",
      "muted": "#FF8A5C"
    },
    "secondary": {
      "base": "#57606F",
      "light": "#747D8C",
      "muted": "#9CA3AF"
    },
    "background": {
      "light": "#F8F9FA",
      "dark": "#0A0A0A"
    },
    "surface": {
      "light": "#FFFFFF",
      "dark": "#141414",
      "higher": "#1C1C1C"
    },
    "text": {
      "primary": {
        "light": "#1F2937",
        "dark": "#FAFAFA"
      },
      "secondary": {
        "light": "#4B5563",
        "dark": "#E5E5E5"
      },
      "muted": {
        "light": "#6B7280",
        "dark": "#A3A3A3"
      },
      "inverse": {
        "light": "#FFFFFF",
        "dark": "#0A0A0A"
      }
    },
    "border": {
      "light": "#DEE2E6",
      "dark": "#404040"
    }
  },
  "superset": {
    "enabled": true
  },
  "logos": {
    "hyperset": {
      "main": "/logos/hyperset-logo.svg",
      "favicon": "/logos/favicon.ico"
    }
  }
}
```

### Color Properties

The simplified palette structure reduces duplication by defining light and dark colors centrally:

#### Primary Colors

| Property | Light Mode | Dark Mode | Usage |
|----------|------------|-----------|-------|
| `base` | `#D35400` | - | Main brand color (light mode) |
| `dark` | `#A04000` | `#FF6B35` | Hover states, dark mode primary |
| `light` | `#E67E22` | - | Lighter variant |
| `muted` | - | `#FF8A5C` | Softer orange for dark backgrounds |

#### Background & Surface

| Property | Light | Dark | Usage |
|----------|-------|------|-------|
| `background.light` | `#F8F9FA` | - | Page background |
| `background.dark` | - | `#0A0A0A` | Dark mode page background |
| `surface.light` | `#FFFFFF` | - | Cards, panels |
| `surface.dark` | - | `#141414` | Dark mode cards |
| `surface.higher` | - | `#1C1C1C` | Elevated surfaces (dark) |

#### Text Colors

| Property | Light Mode | Dark Mode | Usage |
|----------|------------|-----------|-------|
| `text.primary.light` | `#1F2937` | - | Main text |
| `text.primary.dark` | - | `#FAFAFA` | Dark mode main text |
| `text.secondary.light` | `#4B5563` | - | Secondary text |
| `text.secondary.dark` | - | `#E5E5E5` | Dark mode secondary |
| `text.muted.light` | `#6B7280` | - | Disabled, hints |
| `text.muted.dark` | - | `#A3A3A3` | Dark mode muted |
| `text.inverse.dark` | - | `#0A0A0A` | **Button text on orange** |

**Note:** `text.inverse.dark` is crucial for button contrast in dark mode. It ensures dark text (#0A0A0A) on orange buttons for readability.

## Logo Customization

### Logo Files

Place files in the `logos/` folder:

```
logos/
├── hyperset-logo.svg          # Main logo (light bg)
├── hyperset-logo-dark.svg     # Dark variant
├── hyperset-icon.svg          # Icon only
├── favicon.ico                # Browser favicon
└── apple-touch-icon.png       # iOS icon (180x180)
```

### SVG Logo Template

Create your logo in any vector editor (Figma, Illustrator, Inkscape):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50">
  <!-- Your logo design here -->
  <text x="50" y="30" font-family="Inter" fill="#D35400">
    Your Brand
  </text>
</svg>
```

## Superset Theming

Both Portal and Superset theming are applied automatically using the unified palette.

## Example: Orange Theme

```json
{
  "name": "Hyperset Orange Theme",
  "palette": {
    "primary": {
      "base": "#D35400",
      "dark": "#A04000",
      "light": "#E67E22",
      "muted": "#FF8A5C"
    },
    "secondary": {
      "base": "#57606F",
      "light": "#747D8C",
      "muted": "#9CA3AF"
    },
    "background": {
      "light": "#F8F9FA",
      "dark": "#0A0A0A"
    },
    "surface": {
      "light": "#FFFFFF",
      "dark": "#141414",
      "higher": "#1C1C1C"
    },
    "text": {
      "primary": {
        "light": "#1F2937",
        "dark": "#FAFAFA"
      },
      "secondary": {
        "light": "#4B5563",
        "dark": "#E5E5E5"
      },
      "muted": {
        "light": "#6B7280",
        "dark": "#A3A3A3"
      },
      "inverse": {
        "light": "#FFFFFF",
        "dark": "#0A0A0A"
      }
    },
    "border": {
      "light": "#DEE2E6",
      "dark": "#404040"
    }
  },
  "superset": {
    "enabled": true
  }
}
```

## Advanced: Custom CSS

For advanced styling, create a custom CSS file and mount it:

```bash
# In podman-compose.superset.yml volumes:
- ./custom.css:/app/static/assets/custom.css:Z
```

Then add to `superset_config_docker.py`:
```python
EXTRA_CSS = "/static/assets/custom.css"
```

## Troubleshooting

### Changes Not Applied

1. Restart containers: `podman-compose restart`
2. Clear browser cache
3. Check logs: `podman logs hyperset-portal`

### Dark Mode Buttons Have Low Contrast

This is usually caused by button text being the same color as the button background. Ensure `text.inverse.dark` is set to a dark color:

```json
{
  "palette": {
    "text": {
      "inverse": {
        "dark": "#0A0A0A"
      }
    }
  }
}
```

The system automatically uses `text.inverse.dark` for button text in dark mode, ensuring high contrast (dark text on orange buttons).

### Superset Logo Not Changing

Verify:
- Logo file exists in `logos/` folder
- Path matches in `theme.json`

### Colors Look Wrong

- Check color format: Use hex codes (#RRGGBB)
- Verify JSON syntax (no trailing commas)
- Ensure theme.json is valid JSON: `cat theme.json | python -m json.tool`
- Check browser console for theme loading errors

### Migrating from Old Theme Format

If you have an older `theme.json` with separate `hyperset.colors` and `superset.colors` sections:

1. Move all colors to the new unified `palette` section
2. Define light and dark variants for each color
3. Remove duplicate `colors` and `colorsDark` objects
4. Remove per-component overrides (buttons, cards, inputs, etc.)

The new structure automatically generates both light and dark themes from the central palette.

## Branding Checklist

- [ ] Edit `theme.json` with your colors in the `palette` section
- [ ] Set `text.inverse.dark` to ensure button contrast in dark mode
- [ ] Create logo SVG files
- [ ] Update logo paths in `theme.json`
- [ ] Place logos in `logos/` folder
- [ ] Test on both light and dark backgrounds
- [ ] Verify button text is readable in dark mode
- [ ] Verify favicon displays correctly
- [ ] Check mobile responsiveness
