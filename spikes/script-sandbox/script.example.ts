// What an agent would send to `run_script`: plain TypeScript against the `kynimo` SDK.
// It runs once; the result is an ordinary batch of scene operations.
interface Feature {
  label: string;
  color: string;
}

const features: Feature[] = [
  { label: "Fast", color: "#ff5a36" },
  { label: "Typed", color: "#2f6bff" },
  { label: "Editable", color: "#12b76a" },
];

const comp = kynimo.composition("main");
const fps: number = comp.fps;

const title = comp.text("Relay 2.0", { name: "title", position: [960, 300], size: 120 });
title.animate("opacity", { from: 0, to: 1, at: 0, seconds: 0.5, ease: "enter" });

features.forEach((f, i) => {
  const chip = comp.text(f.label, {
    name: `chip-${i + 1}`,
    position: [560 + i * 400, 620],
    size: 56,
    fill: f.color,
  });
  // A stagger is a loop, not a tool the model has to learn.
  const at = Math.round(fps * (0.6 + i * 0.12));
  chip.animate("opacity", { from: 0, to: 1, at, seconds: 0.4, ease: "enter" });
  chip.animate("position.y", { from: 660, to: 620, at, spring: "gentle" });
  // Seeded, so a retry produces the same document.
  chip.set("rotation", (kynimo.random() - 0.5) * 4);
});
