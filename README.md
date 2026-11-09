# Animath

Manim-style animation on your phone: LaTeX-looking maths, graphs, geometry, logic and set theory, nodes and networks, curves and fractals, 3D shapes, title cards, stickers, preset animations, glow, a timeline with keyframes, and video export in any aspect ratio.

## Files

- `index.html`: the app.
- `fonts.css` + `fonts/`: Latin Modern, the LaTeX font (from the GUST font project, GUST Font License), so maths looks like LaTeX offline.
- `core.js`: the engine. Object types (`TYPES`), the maths layout, animations, and rendering. Add a new object type by adding an entry to `TYPES` with `defaults`, `fields` and `build`.
- `editor.js`: the editor: stage, Add panel, inspector, timeline, projects, export, images and sound, library. The demo scenes are `demoScene()` and `tourScene()`.
- `export.js`: turns a scene into Manim Community Python (the Code panel).
- `app.css`: layout and colours.
- `icon.svg`, `icon-*.png`, `maskable-512.png`, `apple-touch-icon.png`: the logo.
- `manifest.webmanifest`, `sw.js`: make it installable and work offline. Bump `VERSION` in `sw.js` after any change.

## Put it on GitHub Pages

1. Create a repo called `animath` and upload everything in this folder, including the `fonts` folder (drag the whole folder onto GitHub's upload page).
2. Settings → Pages → Deploy from branch → `main` / root.
3. Open `https://cosmickillswitch.github.io/animath/` and install it from Chrome's menu (⋮ → Install app).

## How it works

- Tap an object to get the transform box: corners resize, side bars stretch one way (past the middle mirrors it), the round handle rotates (snaps every 15°).
- Draw (first button in the toolbar): Pen for corners and curves, Pencil for freehand, Nodes to move nodes and handles, add nodes, switch smooth/corner and join ends. Style sets line colour, thickness and fill. Done turns the drawing into a normal object; Edit drawing reopens it.
- Animate has four tabs (In, Out, Loop, Effects) with live previews of each preset on your own object. Glow has its own tool.
- The 16:9 ▾ button in the top bar switches the video shape.

- The frame is 8 units tall, with (0, 0) at the centre and y going up, as in Manim.
- Each object is on screen from its start to its end. It has an entrance animation (Create, Write, Fade, Grow…), an exit (Fade, Uncreate, Shrink, or Transform into another object), optional emphasis moments (Indicate, Circumscribe, Wiggle, Flash…) and optional idle motion.
- Keyframes: select a clip, tap ◆ Keyframe, scroll the timeline to a later moment, then drag the object. Position (in the toolbar) keyframes single properties. Drag the diamonds on a selected clip to retime them.
- The timeline scrolls under a fixed playhead. Pinch or use − / + to zoom. Tap a clip to select it, then drag it to move it in time or drag its white handles to trim it.
- Export records the scene in real time to MP4 (or WebM if the browser can't make MP4). Keep the screen on until it finishes.

## Rigs, values, camera and more

- Rig (selection toolbar): group objects, attach one to another as a parent (it then moves, turns and sizes with it), set the pivot it turns around (presets or drag it on the preview), ride along a graph's curve, or follow another object's outline as a motion path. On the preview, the first tap picks a group and a second tap picks the member.
- Values (#): live numbers like Manim's ValueTracker. Keyframe them, show them with `[[a]]` or `[[a:2]]` in any text or maths, use them by name in graph formulas, or drive a position with a formula (Position → Drive with a formula; `t` is seconds and `u` runs 0 → 1 through the clip).
- Out → Match symbols into… is TransformMatchingTex: shared symbols glide to their new places.
- Camera (⌖): pan, zoom and turn the whole view with keyframes, plus Push in, Pull out, Tilt and Focus on.
- Physics presets: Spring, Gravity drop, Spring away, Boing, Hop, Pendulum (swings from the pivot), Springy. Spring, Gravity and Snap are also easings.
- ⌇ next to a keyframe opens the easing editor: presets, Hold, or your own cubic-bezier curve.
- Style: dashed or dotted lines, arrowheads on open lines, gradients, glow, and Hide in the video (keeps it as a faint guide, such as a motion path).
- Text: Curved text, Text ring and Wavy text.
- Media: images (kept in this app's storage on the device) and one sound track, which plays with the preview, shows its waveform on the timeline and is mixed into exported video. Markers (◆ Marker, or M on a keyboard) snap clips to beats. Saved project files carry images and sound with them.
- ❖ Save puts the selection (with its members and animations) in your library, for any project on this device.
- Code (</>): the scene as Manim Python to copy or save. It's generated from the scene, not edited directly; stickers, nodes, fractals and 3D shapes become placeholders, and idle loops other than Spin aren't exported.
