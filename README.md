# Runes of Command

A solo fantasy hex wargame. Deploy your troops, compose their orders with runes, then adapt your strategy during battle using messenger ravens. Lead your company through a roguelite campaign.

Version 1.2.0: English by default, with French available from the language selector. Your explicit language choice is remembered. The recorded soundtrack and audio fixes from 1.1.0 are included.

![Actual gameplay](assets/lob7-cover.jpg)

Original code and 3D models: MIT. Music is excluded from MIT, and third-party components retain their own licences; see [NOTICE.md](NOTICE.md).

## Play locally

From this folder, run `python -m http.server 8765 --bind 127.0.0.1`, then open http://127.0.0.1:8765/ in a recent browser with WebGL. No npm installation or build step is needed. Scripts, models, fonts and music are local. Sound starts after a player gesture. Progress is saved in the browser when local storage is available. Switching languages does not change the save format or gameplay identifiers.

## Controls

- Mouse: select, deploy troops, program runes and choose the next campaign stop
- Camera: left-drag to pan, right-drag to rotate, wheel or middle-drag to zoom
- Keyboard camera: arrow keys or WASD (physical ZQSD on AZERTY); R to reframe or switch between overview and action tracking
- Battle: Space to pause/resume; 1, 2, 3 for ×1, ×2, ×4 speed
- ? or F1 for help; Escape to close or deselect
- Editor: Ctrl/Cmd+Z to undo; Alt+Up/Down to move a rule; Delete/Backspace to remove the selected condition
- Touch: tap to select, drag one finger to pan, use two fingers to zoom/rotate; select English or Français in the language menu

In editor menus: Tab to navigate, arrows to browse, Enter or Space to select, Home/End or Page Up/Down to reach the ends, and letters to search. On a rule handle, Up/Down moves the rule and Home/End sends it to the beginning/end. For numbers: arrows ±1, Page Up/Down ±5, Home/End for minimum/maximum, and Enter to close. On-screen buttons provide the same actions.

## Credits

Design, code and Blender models were made with Claude (Anthropic) for Cédric, according to the project brief. English localisation and LOB7 adaptation: Nilo (Codex). See [NOTICE.md](NOTICE.md) for three.js 0.170.0, fonts and music.
