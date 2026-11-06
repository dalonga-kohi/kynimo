// Test scene drawn with CanvasKit (Skia). Loaded as a classic script in the page and as a
// module in Node, so it only assigns a global. Exercises what M2 needs from Skia: even-odd
// fills, gradients, rounded rects, dashed strokes with round joins/caps and shaped text
// (ligatures, accents, symbols, tracking, line wrapping). Returns the paragraph's longest line
// width so callers can tell an empty layout from a drawn one.
globalThis.drawScene = (CK, canvas, fontBytes, w, h) => {
  canvas.clear(CK.Color(0, 0, 0, 0));

  const fill = new CK.Paint();
  fill.setAntiAlias(true);
  fill.setShader(
    CK.Shader.MakeLinearGradient(
      [0, 0],
      [w, h],
      [CK.Color(255, 90, 40, 1), CK.Color(40, 120, 255, 0.6)],
      null,
      CK.TileMode.Clamp,
    ),
  );
  const blob = new CK.PathBuilder();
  blob.addRRect(CK.RRectXY(CK.LTRBRect(w * 0.1, h * 0.15, w * 0.62, h * 0.7), 48, 48));
  blob.addOval(CK.LTRBRect(w * 0.45, h * 0.3, w * 0.9, h * 0.88));
  blob.setFillType(CK.FillType.EvenOdd);
  const blobPath = blob.detachAndDelete();
  canvas.drawPath(blobPath, fill);

  const stroke = new CK.Paint();
  stroke.setAntiAlias(true);
  stroke.setStyle(CK.PaintStyle.Stroke);
  stroke.setStrokeWidth(9.5);
  stroke.setStrokeJoin(CK.StrokeJoin.Round);
  stroke.setStrokeCap(CK.StrokeCap.Round);
  stroke.setColor(CK.Color(255, 255, 255, 0.85));
  stroke.setPathEffect(CK.PathEffect.MakeDash([28, 14], 5.5));
  const star = new CK.PathBuilder();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 70 : 170;
    const a = (i * Math.PI) / 5 - 0.3;
    const x = w * 0.3 + r * Math.cos(a);
    const y = h * 0.62 + r * Math.sin(a);
    if (i === 0) star.moveTo(x, y);
    else star.lineTo(x, y);
  }
  star.close();
  const starPath = star.detachAndDelete();
  canvas.drawPath(starPath, stroke);

  const fonts = CK.FontMgr.FromData([fontBytes]);
  const style = new CK.ParagraphStyle({
    textStyle: {
      color: CK.Color(255, 255, 255, 1),
      fontFamilies: ["DejaVu Sans"],
      fontSize: 64,
      letterSpacing: -1.2,
    },
    textAlign: CK.TextAlign.Left,
  });
  const builder = CK.ParagraphBuilder.Make(style, fonts);
  builder.addText("Kynimo — ffi Âvé 012 ↗ motion that ships");
  const paragraph = builder.build();
  paragraph.layout(w * 0.8);
  canvas.drawParagraph(paragraph, w * 0.08, h * 0.05);
  const longestLine = paragraph.getLongestLine();

  for (const o of [fill, stroke, blobPath, starPath, paragraph, builder, fonts]) o.delete();
  return { longestLine };
};

// Decodes encoded image bytes with CanvasKit's own codecs (not the browser's) and returns the
// decoded RGBA bytes, so decoding can be compared between Node and Chromium.
globalThis.decodeImage = (CK, bytes) => {
  const image = CK.MakeImageFromEncoded(new Uint8Array(bytes));
  const px = image.readPixels(0, 0, {
    width: image.width(),
    height: image.height(),
    colorType: CK.ColorType.RGBA_8888,
    alphaType: CK.AlphaType.Premul,
    colorSpace: CK.ColorSpace.SRGB,
  });
  image.delete();
  return px;
};
