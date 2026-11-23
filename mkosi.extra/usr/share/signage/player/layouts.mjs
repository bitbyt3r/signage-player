// Display layouts: how the player's logical canvas maps onto the video
// output. The only table of this geometry; the player (display.mjs) and
// scripts/ograf-preview.html both read it.
//
// A layout has
//   canvas   [w, h]           the logical surface graphics render into
//   output   [w, h]           the video mode the LED controller expects
//   regions  {name: {rect, out}}
//            rect [x, y, w, h] a visible part of the canvas
//            out  [x, y]       where that part goes on the output
//   hidden   {name: rect}     canvas areas no LED shows (for previews)
//
// "screen" (an ordinary monitor) isn't in here: the canvas is the viewport.

export const LAYOUTS = {
    // The entrance arch: an 11.5 x 7 cabinet header over two legs, every
    // cabinet 240 x 135 px, so the pixel pitch is the same everywhere and
    // the legs sit directly under the header's outer ends. The controller
    // takes 3840x2160 with the header and the two leg strips side by side,
    // upright, the 360 px (left) leg first; the rest of the output is unused.
    arch: {
        canvas: [2760, 2565],
        output: [3840, 2160],
        regions: {
            header: { rect: [0, 0, 2760, 945], out: [0, 0] },
            left: { rect: [0, 945, 360, 1620], out: [2760, 0] },
            right: { rect: [2280, 945, 480, 1620], out: [3120, 0] },
        },
        hidden: { door: [360, 945, 1920, 1620] },
    },
};

export const LAYOUT_NAMES = ["screen", ...Object.keys(LAYOUTS)];
