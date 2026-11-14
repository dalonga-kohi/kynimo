import type { CSSProperties } from "react";

/**
 * The thumbnail artwork of the design, copied from its export (03-animations, 04-player). The
 * browser mock shows these where the app shows rendered frames. Positions are px in a 416x234 box.
 */

const sans = '"Mona Sans Variable", "Mona Sans", system-ui, sans-serif';
const mono = '"Geist Mono Variable", "Geist Mono", system-ui, sans-serif';
const abs = (style: CSSProperties): CSSProperties => ({ position: "absolute", ...style });

export function LaunchWeekArt() {
  return (
    <>
      <div style={abs({ backgroundColor: "#F5C842", height: 44, left: 36, top: 70, width: 28 })} />
      <div
        style={abs({
          color: "#EDE8DF",
          fontFamily: sans,
          fontSize: 30,
          fontStretch: "125%",
          fontVariationSettings: '"wdth" 125',
          fontWeight: 800,
          left: 36,
          letterSpacing: "-0.02em",
          lineHeight: "32px",
          top: 130,
          whiteSpace: "nowrap",
        })}
      >
        Launch week
      </div>
      <div style={abs({ backgroundColor: "#F5C842", height: 3, left: 36, top: 176, width: 48 })} />
    </>
  );
}

export function NimbusThumbArt() {
  return (
    <div style={abs({ inset: 0, backgroundColor: "#000000" })}>
      <div
        style={abs({
          backgroundImage:
            "radial-gradient(ellipse 60% 70% at 50% 110% in oklab, #2997FF73 0%, #00000000 70%)",
          height: 234,
          left: 0,
          top: 0,
          width: 416,
        })}
      />
      <div style={abs({ display: "flex", justifyContent: "center", left: 0, top: 84, width: 416 })}>
        <div
          style={{
            color: "#FFFFFF",
            fontFamily: sans,
            fontSize: 40,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            lineHeight: "48px",
          }}
        >
          Nimbus 2
        </div>
      </div>
      <div
        style={abs({ display: "flex", justifyContent: "center", left: 0, top: 138, width: 416 })}
      >
        <div style={{ color: "#A1A1A6", fontFamily: sans, fontSize: 13, lineHeight: "16px" }}>
          Faster. Quieter. Yours.
        </div>
      </div>
    </div>
  );
}

export function FridayArt() {
  return (
    <div style={abs({ inset: 0, backgroundColor: "#FFFAF2" })}>
      <div
        style={abs({
          backgroundColor: "#6C47FF",
          borderRadius: 999,
          height: 180,
          left: 270,
          top: -30,
          width: 180,
        })}
      />
      <div
        style={abs({
          backgroundColor: "#FFC93C",
          borderRadius: 18,
          height: 64,
          left: 300,
          rotate: "-12deg",
          top: 150,
          transformOrigin: "0% 0%",
          width: 64,
        })}
      />
      <div
        style={abs({
          color: "#1B1530",
          fontFamily: sans,
          fontSize: 38,
          fontWeight: 800,
          left: 32,
          letterSpacing: "-0.03em",
          lineHeight: "40px",
          top: 72,
          whiteSpace: "pre-wrap",
        })}
      >
        Ship it
        <br />
        on Friday.
      </div>
      <div
        style={abs({
          backgroundColor: "#1B1530",
          borderRadius: 999,
          display: "flex",
          left: 32,
          padding: "7px 14px",
          top: 170,
        })}
      >
        <div
          style={{
            color: "#FFFAF2",
            fontFamily: sans,
            fontSize: 12,
            fontWeight: 600,
            lineHeight: "16px",
          }}
        >
          Start free
        </div>
      </div>
    </div>
  );
}

export function EssayArt() {
  return (
    <div style={abs({ inset: 0, backgroundColor: "#F4F1EA" })}>
      <div
        style={abs({
          color: "#B3261E",
          fontFamily: mono,
          fontSize: 10,
          left: 32,
          letterSpacing: "0.08em",
          lineHeight: "12px",
          top: 32,
        })}
      >
        ESSAY · NO. 14
      </div>
      <div style={abs({ backgroundColor: "#1A1714", height: 2, left: 32, top: 56, width: 120 })} />
      <div
        style={abs({
          color: "#1A1714",
          fontFamily: sans,
          fontSize: 40,
          fontStretch: "85%",
          fontVariationSettings: '"wdth" 85',
          fontWeight: 500,
          left: 32,
          letterSpacing: "-0.02em",
          lineHeight: "42px",
          top: 76,
          width: 340,
        })}
      >
        The quiet year of small tools.
      </div>
      <div
        style={abs({
          color: "#5B554C",
          fontFamily: sans,
          fontSize: 12,
          left: 32,
          lineHeight: "16px",
          top: 188,
        })}
      >
        By Ines Marlow
      </div>
    </div>
  );
}

export function BlackFridayArt() {
  return (
    <div style={abs({ inset: 0, backgroundColor: "#FFFFFF" })}>
      <div
        style={abs({ backgroundColor: "#FF2A00", height: 232, left: 236, top: 0, width: 180 })}
      />
      <div
        style={abs({
          color: "#000000",
          fontFamily: sans,
          fontSize: 52,
          fontStretch: "125%",
          fontVariationSettings: '"wdth" 125',
          fontWeight: 900,
          left: 24,
          letterSpacing: "-0.04em",
          lineHeight: "48px",
          top: 40,
          whiteSpace: "pre-wrap",
        })}
      >
        NO
        <br />
        FILLER.
      </div>
      <div
        style={abs({
          color: "#000000",
          fontFamily: mono,
          fontSize: 11,
          left: 24,
          lineHeight: "14px",
          top: 190,
        })}
      >
        SALE ENDS 11.30
      </div>
    </div>
  );
}

export function Q3Art() {
  const bar = (left: number, top: number, height: number, color: string): CSSProperties =>
    abs({
      backgroundColor: color,
      borderTopLeftRadius: 4,
      borderTopRightRadius: 4,
      height,
      left,
      top,
      width: 28,
    });
  return (
    <div style={abs({ inset: 0, backgroundColor: "#000000" })}>
      <div
        style={abs({
          color: "#FFFFFF",
          fontFamily: sans,
          fontSize: 15,
          fontWeight: 600,
          left: 32,
          lineHeight: "18px",
          top: 32,
        })}
      >
        Q3 revenue
      </div>
      <div
        style={abs({
          color: "#2997FF",
          fontFamily: sans,
          fontSize: 34,
          fontWeight: 700,
          left: 32,
          letterSpacing: "-0.02em",
          lineHeight: "42px",
          top: 52,
        })}
      >
        +41%
      </div>
      <div style={bar(200, 150, 52, "#2C2C2E")} />
      <div style={bar(240, 126, 76, "#2C2C2E")} />
      <div style={bar(280, 110, 92, "#2C2C2E")} />
      <div style={bar(320, 60, 142, "#2997FF")} />
      <div style={abs({ backgroundColor: "#3A3A3C", height: 1, left: 32, top: 202, width: 352 })} />
    </div>
  );
}

/** The frame of the Player board: "Nimbus 2" on a 912x513 stage. */
export function NimbusPlayerArt() {
  return (
    <div style={abs({ inset: 0, backgroundColor: "#000000" })}>
      <div
        style={abs({
          backgroundImage:
            "radial-gradient(ellipse 55% 65% at 50% 115% in oklab, #2997FF80 0%, #00000000 70%)",
          height: "100%",
          left: 0,
          top: 0,
          width: "100%",
        })}
      />
      <div
        style={abs({
          display: "flex",
          justifyContent: "center",
          left: 0,
          top: "37%",
          width: "100%",
        })}
      >
        <div
          style={{
            color: "#FFFFFF",
            fontFamily: sans,
            fontSize: 88,
            fontWeight: 700,
            letterSpacing: "-0.035em",
            lineHeight: "106px",
          }}
        >
          Nimbus 2
        </div>
      </div>
      <div
        style={abs({
          display: "flex",
          justifyContent: "center",
          left: 0,
          top: "59.6%",
          width: "100%",
        })}
      >
        <div style={{ color: "#A1A1A6", fontFamily: sans, fontSize: 24, lineHeight: "30px" }}>
          Faster. Quieter. Yours.
        </div>
      </div>
    </div>
  );
}
