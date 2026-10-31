# Funcionalidades y decisiones de diseño

Este documento lista las funcionalidades de Rounded Window Corners Plane y,
sobre todo, **por qué** se implementaron de la forma en que están. La idea es
que antes de cambiar algo se pueda saber qué problema resolvía, para no
reintroducirlo.

Cada entrada tiene:

- **Qué hace**: el comportamiento visible.
- **Por qué**: el problema que motivó la implementación.
- **Dónde**: archivos principales.

Al agregar o cambiar una funcionalidad, actualiza su entrada o agrega una
nueva en la sección de historial.

---

## Renderizado

### Esquinas redondeadas, borde y sombra en un solo shader

- **Qué hace**: un único fragment shader recorta las esquinas (con suavizado
  tipo *squircle*), dibuja el borde y calcula la sombra de la ventana.
- **Por qué**: antes la sombra era un actor aparte, renderizado offscreen a 2x
  con su propio efecto de recorte (`clip_shadow_effect`). Eso duplicaba el
  trabajo y la VRAM por ventana, y obligaba a crear actores extra en el
  overview y al cambiar de escritorio. Al calcular la sombra en el mismo
  shader desaparecen esos actores y la sombra sigue a la ventana sin desfase.
- **Dónde**: `src/effect/rounded_corners_effect.ts`,
  `src/effect/shader/rounded_corners.frag`.

### Render a la escala real del monitor (escalado fraccional)

- **Qué hace**: cada ventana se renderiza a la escala real del monitor (por
  ejemplo 1.5) y el buffer se alinea con la rejilla de píxeles de la pantalla.
- **Por qué**: `Clutter.OffscreenEffect`, que usaba Reborn, renderiza a
  `ceil(escala)` (2x a 150 %) y luego encoge la imagen, lo que vuelve borroso o
  dentado el texto. Además Mutter no coloca las ventanas en píxeles físicos
  enteros (a 150 % una posición lógica impar cae en medio píxel), así que el
  buffer se ubica según la pantalla y no según el actor, y cada píxel de la
  ventana corresponde exactamente a uno de la pantalla.
- **Dónde**: `RoundedCornersEffect` (`paintScale`, `screenOrigin`, `phase`,
  `#ensureTarget`).

### Bordes y padding ajustados a píxeles enteros

- **Qué hace**: los bordes de la ventana, el padding de recorte y el grosor
  del borde se redondean a píxeles físicos enteros, siempre hacia adentro.
- **Por qué**: a 150 % un borde de 1 px mide 1.5 píxeles. Según la paridad de
  cada lado se veía como un píxel lleno más uno tenue o al revés, y los lados
  opuestos se veían distintos y cambiaban al mover la ventana. Redondear hacia
  adentro garantiza que el recorte nunca muestre medio píxel de la ventana.
- **Dónde**: `#snapEdges` en `rounded_corners_effect.ts`.

### Buffers offscreen por ventana con presupuesto de VRAM

- **Qué hace**: cada ventana tiene su propio buffer offscreen y solo se
  vuelve a renderizar cuando cambia su contenido, tamaño o posición. Todos los
  buffers comparten un presupuesto de VRAM (`BUFFER_BUDGET_BYTES`, 512 MiB).
  Si una ventana necesita un buffer y no hay presupuesto, toma el de la
  ventana que lleva más tiempo sin pintarse (LRU), y esa otra se vuelve a
  renderizar cuando se pinte. El presupuesto cuenta 8 bytes por píxel: 4 de
  color y 4 del buffer de profundidad y stencil que Cogl crea junto a cada
  framebuffer offscreen (desde GJS no se puede evitar). Antes contaba solo el
  color, así que "512 MiB" eran en realidad ~1 GiB: con la extensión activa
  gnome-shell usaba 0.9–1.2 GB más que sin ella. Un temporizador libera cada
  2 s los buffers que no se pintan desde hace 10 s (por ejemplo, los de
  ventanas de otros escritorios tras cerrar el overview); antes solo se
  revisaba al pintar, así que con el escritorio quieto nunca se liberaban.
- **Por qué**: es el equilibrio entre dos problemas reales que aparecieron uno
  después del otro (ver el [historial](#historial-de-buffers-offscreen)):
  1. Un buffer por ventana sin límite llegó a consumir **varios GB de VRAM**.
  2. Un único buffer compartido por todas las ventanas resolvió la memoria,
     pero hacía que el overview (ver escritorios o aplicaciones) se viera
     cortado: en el overview se pintan todas las ventanas y los clones de las
     miniaturas en cada frame, y con un solo buffer cada ventana se volvía a
     renderizar en cada frame, con un `flush()` a la GPU entre una y otra.

  Con el presupuesto, el caso normal (las ventanas caben) es fluido, y en el
  peor caso (muchas ventanas grandes) se degrada al comportamiento del buffer
  compartido en vez de seguir reservando memoria.
- **Dónde**: `acquireBuffer`, `ensureBuffer`, `releaseIdleBuffers`,
  `startIdleCheck` en
  `rounded_corners_effect.ts`.

### No pintar ventanas en monitores que no las muestran

- **Qué hace**: antes de pintar, el efecto proyecta el área de la ventana
  (con sombra) sobre el monitor que se está pintando. Si queda fuera, no pinta
  nada ni reserva buffer.
- **Por qué**: los logs de depuración mostraron que, con dos monitores (4K a
  1.5 y otro a 1), cada ventana del monitor 4K tenía además un buffer a escala
  1 para el segundo monitor, donde estaba fuera de pantalla: unos 120 MiB y
  un render extra por ventana sin ningún efecto visible. Las ventanas con este
  efecto se pintaban en todos los monitores.
- **Límite**: solo aplica cuando la ventana se pinta sin transformar. En el
  overview, las animaciones o ventanas deformadas no se descarta nada.
- **Dónde**: `offView` en `rounded_corners_effect.ts`.

### Recolección de basura forzada al liberar buffers

- **Qué hace**: se programa un `System.gc()` en idle cuando se han liberado
  64 MiB de buffers, y también después de cada barrido de buffers inactivos.
  Al desactivar la extensión se fuerza de inmediato.
- **Por qué el umbral bajó de 256 a 64 MiB**: con 256 MiB, cientos de MiB de
  texturas ya soltadas seguían ocupando VRAM a la espera del recolector; se
  veía como diferencias de ~300 MiB entre mediciones con `nvidia-smi` en el
  mismo estado.
- **Por qué**: GJS solo libera una textura cuando su objeto JS se recolecta, y
  el recolector solo cuenta la memoria de JS, no la VRAM que hay detrás. Sin
  esto, las texturas descartadas (por ejemplo al redimensionar) se acumulaban
  por gigas aunque ya no se usaran.
- **Dónde**: `releaseBuffer`, `releaseBuffers` en `rounded_corners_effect.ts`.

### Vistas previas del overview sin efectos extra (se quitó el filtro lineal)

- **Qué hace**: las vistas previas del overview y las miniaturas de los
  escritorios son clones de la ventana, así que la pintan con el efecto,
  sombra incluida, desde el buffer que la ventana ya tiene. No se parchea
  nada de GNOME para ellas.
- **Por qué**: antes se añadía un `LinearFilterEffect` (filtrado lineal con
  mipmaps) a cada vista previa para disimular un bug de GNOME que las hace
  verse borrosas. Se quitó porque era la causa principal de los tirones y de
  los picos de VRAM al abrir el overview:
  - Es un `Clutter.OffscreenEffect`, que renderiza a `ceil(escala)`: a 150 %,
    una ventana maximizada de un monitor 4K (2560×1440 lógicos) ocupaba un FBO
    de 5120×2880, unos 59 MiB, y unos 79 MiB con mipmaps.
  - GNOME crea una vista previa nueva por ventana cada vez que se abre el
    overview, así que cada apertura reservaba otro FBO por ventana y generaba
    sus mipmaps, lo que bloqueaba la GPU en la animación.
  - Al cerrar el overview, GJS solo libera esas texturas cuando pasa el
    recolector de basura, y quedaban fuera del presupuesto de VRAM de los
    buffers. Medido con `nvidia-smi` en GNOME 51, con dos monitores 4K a
    1.5 y uno 1080p a 1: gnome-shell pasaba de 441 MiB a 4149, 2099, 1096
    y 3701 MiB al abrir y cerrar el overview varias veces.
  - Además, la ventana se renderizaba dos veces por vista previa: una en el
    FBO del filtro a 2x y otra en el buffer del efecto.
- **Si se quiere recuperar la suavidad**: hacerlo en el pipeline del propio
  efecto (por ejemplo, mipmaps de su buffer solo mientras se pinta escalado),
  nunca con otro efecto offscreen por vista previa.

### Compatibilidad con efectos que deforman la ventana

- **Qué hace**: las ventanas gelatinosas de *Compiz windows effect* y la
  lámpara mágica de *Compiz alike magic lamp effect* deforman la ventana ya
  redondeada, con borde incluido. La sombra se oculta durante la deformación y
  reaparece con un fundido de 150 ms.
- **Por qué**: Clutter aplica los efectos en el orden en que se agregaron, y
  cada uno envuelve a los que se agregaron después. Esos efectos se agregan
  después del nuestro, así que la máscara recortaba la ventana deformada en el
  marco original. Por eso el efecto se reordena detrás de ellos. La sombra se
  oculta porque el efecto de deformación está dimensionado solo para la
  ventana y la cortaría. En XWayland nuestro efecto vive en la superficie y los
  otros en el actor, así que siempre lo envuelven.
- **Dónde**: `#deformState`, `#updateDeformed`, `#scheduleUpdate` en
  `rounded_corners_effect.ts`.

### Soporte de GNOME Shell 51

- **Qué hace**: el efecto se basa en `Clutter.Effect`/`Clutter.ShaderEffect`
  y `Cogl.Snippet`.
- **Por qué**: GNOME 51 eliminó `Shell.GLSLEffect`, que era la base del efecto
  original. Antes, en GNOME 48, también se había eliminado `Shell.SnippetHook`
  y se reemplazó por `Cogl.SnippetHook`.

---

## Comportamiento de ventanas

### Color de borde para ventanas sin foco

- **Qué hace**: un color de borde distinto para ventanas sin foco, global y
  por aplicación.
- **Por qué**: permite distinguir de un vistazo la ventana activa sin depender
  solo de la sombra. Se agregó manteniendo compatibilidad con versiones
  anteriores de la configuración.
- **Dónde**: `onFocusChanged` en `src/manager/event_handlers.ts`,
  `updateUniforms` en el efecto.

### Ocultar efectos al mover o redimensionar

- **Qué hace**: opcional (activado por defecto). Mientras una ventana se mueve
  o cambia de tamaño con el puntero, se ocultan el borde, el redondeo y la
  sombra; al terminar vuelven con un fundido de 180 ms. Un clic en la barra de
  título no los oculta.
- **Por qué**: durante el arrastre la ventana cambia de geometría en cada
  frame, lo que obliga a recalcular y volver a renderizar el efecto
  constantemente. El movimiento real se detecta aparte del ajuste para que
  activarlo o desactivarlo a mitad de un arrastre sea seguro. Se respeta la
  preferencia de GNOME de desactivar animaciones.
- **Dónde**: `onMoveBegin`, `onInteractionGeometryChanged`, `onMoveEnd`,
  `restoreWithTransition` en `event_handlers.ts`.

### Margen exterior para ventanas maximizadas y en mosaico

- **Qué hace**: opcional (desactivado por defecto). Reserva de 0 a 64 px
  lógicos alrededor de las ventanas maximizadas y en mosaico. No afecta a las
  ventanas en pantalla completa.
- **Por qué**: las esquinas redondeadas de una ventana maximizada quedan
  pegadas al borde de la pantalla. Se reserva el espacio en el área de trabajo
  de GNOME en vez de mover las ventanas, para que conserven sus estados
  nativos (maximizada, en mosaico) y su contenido se redimensione bien.
- **Dónde**: `src/manager/window_margin.ts`.

### Sombra en ventanas maximizadas o en pantalla completa

- **Qué hace**: opción para mantener la sombra cuando la ventana está
  maximizada o en pantalla completa. Por defecto se quita el redondeo en esos
  estados.
- **Por qué**: agregado en upstream (PR #126). En pantalla completa el
  redondeo normalmente estorba, pero hay quien prefiere conservar la sombra.

### Lista negra y lista blanca de aplicaciones, y ajustes por aplicación

- **Qué hace**: excluir aplicaciones (lista negra) o limitar el efecto a
  algunas (lista blanca), y sobrescribir radio, padding, suavizado y colores
  de borde por clase de ventana (`wmClass`).
- **Por qué**: algunas aplicaciones ya dibujan sus propias esquinas o se ven
  mal recortadas. Se usa `wmClass` en vez del título porque es estable y
  facilita depurar.
- **Dónde**: `shouldEnableEffect` en `src/manager/utils.ts`,
  `src/preferences/pages/blacklist.ts`, `src/preferences/pages/custom.ts`.

### Omitir apps libadwaita/libhandy

- **Qué hace**: opción para no aplicar el efecto a aplicaciones libadwaita o
  libhandy, que ya tienen esquinas redondeadas propias.
- **Por qué**: se detecta leyendo `/proc/<pid>/maps` para ver si cargan la
  biblioteca. Los errores de permiso al leer ese archivo son esperables en
  algunos procesos, por eso se registran como debug y no como error.

### Selector de ventanas en las preferencias

- **Qué hace**: en las preferencias se puede hacer clic en una ventana para
  obtener su clase.
- **Por qué**: las preferencias corren en un proceso aislado sin acceso a
  GNOME Shell. Un servicio D-Bus exportado por la extensión abre el selector
  de Looking Glass y devuelve la clase de la ventana elegida.
- **Dónde**: `src/window_picker/`.

---

## Correcciones con motivo propio

Correcciones que parecen innecesarias pero no lo son:

- **No aplicar el efecto dos veces a la misma ventana**: causaba una fuga de
  VRAM (upstream #118).
- **Refresco tras desminimizar Chromium**: Chromium a veces desminimiza la
  ventana en una posición errónea y luego la mueve; sin un refresco posterior
  el efecto recortaba parte de la ventana (upstream #124).
- **Cola por actor en los manejadores de eventos** (`withActorLock`): evita
  refrescar el efecto muchas veces por el mismo evento.
- **Comprobaciones de `metaWindow` en señales de tamaño/foco**: algunas señales
  llegan después de que la `Meta.Window` se liberó.
- **El radio del borde y la sombra no se escalan con la escala del monitor**:
  desde GNOME 50 ya no hace falta, y escalarlos los duplicaba.

---

## Historial de buffers offscreen

La forma de renderizar las ventanas offscreen cambió varias veces. Este es el
orden y la razón de cada cambio:

1. **`Clutter.OffscreenEffect` por ventana** (heredado de Reborn). Un buffer
   por ventana, renderizado a `ceil(escala)`. Texto borroso con escalado
   fraccional y la sombra en un actor aparte, también offscreen a 2x.
2. **Efecto propio a la escala real, un buffer por ventana.** Resuelve la
   nitidez, pero el consumo de VRAM llegó a **varios GB**: un buffer por
   ventana y por escala sin límite, más texturas descartadas que GJS no
   liberaba hasta una recolección de basura.
3. **Un único buffer compartido por escala** (commit `045db50`). La VRAM baja
   al tamaño de una ventana por escala. Efecto secundario: el overview se ve
   cortado y pausado, porque cada ventana (y cada clon de las miniaturas) se
   vuelve a renderizar en el buffer en cada frame, con un `flush()` a la GPU
   entre ventanas.
4. **Buffer por ventana con presupuesto de 512 MiB y reemplazo LRU**. Las
   ventanas conservan su render mientras quepan en el presupuesto; la VRAM de
   estos buffers tiene un tope fijo, y si no alcanza se degrada al
   comportamiento del paso 3 en vez de crecer. La recolección de basura
   forzada sigue activa para que las texturas descartadas no se acumulen.
5. **Sin `LinearFilterEffect` en el overview**. Con el paso 4
   el overview seguía con tirones y gnome-shell llegaba a 4 GB de VRAM. El
   responsable era el filtro lineal de las vistas previas, que creaba un FBO
   a 2x con mipmaps por ventana en cada apertura del overview, fuera del
   presupuesto (ver "Vistas previas del overview sin efectos extra"). Sin
   él, las vistas previas reutilizan el buffer de cada ventana.
6. **Sin buffers para monitores que no muestran la ventana** (estado
   actual). Al contar el coste real (8 B/píxel) y liberar por temporizador, la
   VRAM no bajaba: los logs mostraron que cada ventana se pintaba también en
   los monitores donde estaba fuera de pantalla, con un buffer por escala.

Si hay que ajustar el tope, cambia `BUFFER_BUDGET_BYTES` en
`src/effect/rounded_corners_effect.ts`. Como referencia, una ventana
maximizada ocupa unos 20 MiB en un monitor 1080p y unos 72 MiB en uno 4K,
contando color, profundidad y stencil.

Si con muchas ventanas el overview vuelve a dar tirones, es que no caben en
el presupuesto y se están reemplazando en cada frame: hay que subir el tope o
reducir lo que ocupa cada ventana.
