#!/usr/bin/env bash
set -euo pipefail

if ! command -v gnome-shell >/dev/null || ! command -v dbus-run-session >/dev/null; then
    echo 'Se necesitan gnome-shell y dbus-run-session para abrir la sesión de prueba.' >&2
    exit 1
fi

shell_help=$(gnome-shell --help-all 2>&1)
if [[ "$shell_help" != *'--devkit'* ]]; then
    cat >&2 <<'MESSAGE'
El GNOME Shell/Mutter instalado no incluye soporte para --devkit.
Instalar mutter-devkit por separado no habilita esa opción: Mutter también debe
estar compilado con Devkit. Revisa los paquetes de tu distribución.
La sesión de prueba no se ha iniciado y tu escritorio sigue intacto.
MESSAGE
    exit 1
fi

exec dbus-run-session -- gnome-shell --devkit --wayland "$@"
