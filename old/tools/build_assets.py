#!/usr/bin/env python3
"""assets/src/daruma-sheet-src.png を切り出して assets/ 以下の素材を作る。

生成物はコミットしてあるので普段は走らせなくていい。元絵を描き直したとき、
あるいは切り抜きの当たりを直したいときにここを回す。

    python tools/build_assets.py

必要なもの: pillow, numpy, scipy

--- 切り抜きの方針 -------------------------------------------------------
元絵は暗い背景の上に描かれている。単純な「暗い色を透明にする」では
鬼だるまの黒い胴も子供の黒髪も一緒に消えるので、二段構えにしてある。

だるま: 背景は横方向のグラデーションなので、スプライトの左右にある
        「絵が何もない列」から行ごとに2次式を当てて背景を復元し、その差分を取る。
        差分の低い領域のうち枠に繋がっているものだけを背景とみなす(塗りつぶし)ので、
        胴の内側が暗くても穴が開かない。

子供: 背景が霧で、色の差分だけでは霧の濃淡と区別がつかない。かわりに
      「線画の密度」を使う。子供には黒い輪郭線が詰まっていて霧には無いので、
      強い線 (E2 > INK_STRONG) の密度が高い場所だけを体と認める。

どちらも縁のピクセルは背景の暗さを吸っているため、最後に背景色を差し引く
(defringe)。これをしないと明るいテーマの上に置いたとき黒い縁が出る。
"""

import glob
import json
import os
import re
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'src', 'daruma-sheet-src.png')
RUN_SRC = os.path.join(ROOT, 'sozai')   # 走りのコマ割り。1ファイル = 1人 × 8コマ
OUT = os.path.join(ROOT, 'assets')

# --- 元絵の中で何がどこにあるか ---------------------------------------------
# 上から4段がだるま、一番下が子供たち。左右に同じだるまが向き違いで並ぶ。
BANDS = [
    ('normal', 10, 196),
    ('red', 198, 380),
    ('attack', 382, 556),
    ('oni', 558, 736),
]
SIDES = {
    # x0,x1 = 切り出す窓。flanks = 背景を推定するのに使う「何も無い列」
    'left':  dict(x0=330, x1=545, flanks=((240, 330), (545, 600))),
    'right': dict(x0=960, x1=1165, flanks=((895, 960), (1165, 1255))),
}
KIDS_BAND = (742, 1024)
KIDS_LABEL_PLATE = (0, 64, 0, 300)      # 「子供たち(ワラワラ)」の札。子供ではない

INK = 5.0               # これ以上を線画とみなす。輪郭を閉じて体にする
INK_CLOSE = 7           # 輪郭の隙間を橋渡しする半径
KID_GROW = 12           # 縄張りの遊び。手足がまっすぐ切られるのを防ぐ

# 採用する子。元絵の中の座標(x, y)で指す。
#
# 元絵は30人以上が重なって走っている群れなので、自動で抜けるのはこのくらい。
# 残りは隣の子の手足や霧を巻き込む(前列は特に、床の靄に線画に近い濃淡がある)。
# 抜けの良し悪しは結局見て決めるしかないので、通ったものを座標で名指ししてある。
# 元絵を描き直したらここも取り直すこと。
KID_ANCHORS = [
    (205, 857), (283, 882), (381, 833), (483, 824), (755, 846),
    (859, 789), (1021, 827), (1131, 803), (1248, 804),
]
ANCHOR_TOL = 14

DARUMA_CANVAS = (224, 208)
ICON_SIZE = 128

RUN_FRAMES = 8          # 1人あたりのコマ数(2段 × 4列)
RUN_HEIGHT = 128        # 書き出す1コマの高さ。ゲームでは60px前後で使う
RUN_MIN_AREA = 3000     # これ未満の島はコマではない(取りこぼしの粒)
# 元絵の中で1人だけ左を向いて描かれていた。ゴールは右なので反転して揃える。
# 番号は sozai/ のファイル名の (n)。
RUN_FLIP = {7}


def disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r


def defringe(rgb, alpha, bg):
    """縁の半透明ピクセルから背景の色を抜く。

    観測 I = a*C + (1-a)*B なので C = (I - (1-a)B) / a。これをやらないと
    暗い背景で撮った素材が、明るい背景の上で黒く縁取られて見える。
    """
    a = np.clip(alpha, 0, 1)[..., None]
    safe = np.maximum(a, 0.35)          # a が小さいほど復元は暴れるので下限を切る
    out = (rgb - (1 - a) * bg) / safe
    return np.clip(out, 0, 255)


def trim(rgb, alpha, pad=4, thresh=0.03):
    ys, xs = np.where(alpha > thresh)
    if not len(ys):
        return None
    h, w = alpha.shape
    ry = slice(max(0, ys.min() - pad), min(h, ys.max() + 1 + pad))
    rx = slice(max(0, xs.min() - pad), min(w, xs.max() + 1 + pad))
    return rgb[ry, rx], alpha[ry, rx]


def to_image(rgb, alpha):
    return Image.fromarray(
        np.dstack([np.round(rgb), np.round(alpha * 255)]).astype(np.uint8), 'RGBA')


# --- だるま -----------------------------------------------------------------

def daruma_bg(A, y0, y1, x0, x1, flanks, deg=2):
    """行ごとに、スプライトの左右の空き列へ2次式を当てて背景を復元する。"""
    lx = np.arange(*flanks[0])
    rx = np.arange(*flanks[1])
    xs = np.concatenate([lx, rx]).astype(np.float32)
    tgt = np.arange(x0, x1).astype(np.float32)
    out = np.empty((y1 - y0, x1 - x0, 3), np.float32)
    for i, y in enumerate(range(y0, y1)):
        for c in range(3):
            vals = np.concatenate([A[y, lx, c], A[y, rx, c]])
            out[i, :, c] = np.polyval(np.polyfit(xs, vals, deg), tgt)
    return out


def cut_daruma(A, y0, y1, x0, x1, flanks, t_bg=14.0, lo=6.0, hi=30.0, open_r=4):
    fg = A[y0:y1, x0:x1]
    bg = daruma_bg(A, y0, y1, x0, x1, flanks)
    d = np.sqrt(((fg - bg) ** 2).sum(axis=2))

    # 差分の小さい領域のうち、窓の縁から辿り着けるものだけが背景。
    # 胴の内側の暗い部分は縁と繋がっていないので生き残る。
    lab, _ = ndi.label(d < t_bg)
    edge = set(lab[0]) | set(lab[-1]) | set(lab[:, 0]) | set(lab[:, -1])
    edge.discard(0)
    sil = ndi.binary_fill_holes(largest(~np.isin(lab, list(edge))))
    # 背景の横線が胴にくっついてくることがある。開くと細い付着物だけ落ちる
    sil = ndi.binary_fill_holes(largest(ndi.binary_opening(sil, disk(open_r))))

    inner = ndi.binary_erosion(sil, disk(3))
    soft = np.clip((d - lo) / (hi - lo), 0, 1)
    alpha = np.where(inner, 1.0, np.where(sil, np.maximum(soft, 0.4), 0.0))
    alpha = ndi.gaussian_filter(alpha, 0.7) * ndi.binary_dilation(sil, disk(2))
    return trim(defringe(fg, alpha, bg), alpha)


def largest(mask):
    lab, n = ndi.label(mask)
    if not n:
        return mask
    sizes = ndi.sum(mask, lab, range(1, n + 1))
    return lab == int(np.argmax(sizes)) + 1


def place(img, size, bottom_margin=6):
    """共通のキャンバスに、左右中央・下揃えで置く。

    向きやタイプを切り替えたときに絵が跳ねないよう、8枚とも同じ寸法・同じ
    接地線にしておく。CSS 側は位置合わせを気にしなくてよくなる。
    """
    canvas = Image.new('RGBA', size, (0, 0, 0, 0))
    x = (size[0] - img.width) // 2
    y = size[1] - bottom_margin - img.height
    canvas.paste(img, (x, max(0, y)), img)
    return canvas


def fit(img, size, margin=4):
    box = size - margin * 2
    s = min(box / img.width, box / img.height)
    r = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))),
                   Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(r, ((size - r.width) // 2, (size - r.height) // 2), r)
    return canvas


# --- 子供 -------------------------------------------------------------------

def kids_bg(band, scale=4, msize=27):
    """子供より広い窓の中央値を取ると、霧と床だけが残る。"""
    h, w, _ = band.shape
    small = np.asarray(Image.fromarray(band.astype(np.uint8))
                       .resize((w // scale, h // scale), Image.BILINEAR)).astype(np.float32)
    med = np.dstack([ndi.median_filter(small[:, :, c], size=msize) for c in range(3)])
    up = np.asarray(Image.fromarray(med.astype(np.uint8)).resize((w, h), Image.BICUBIC))
    return ndi.gaussian_filter(up.astype(np.float32), (3, 3, 0))


def kids_fields(A):
    """子供バンドの共通前処理。背景推定・色差・線画の強さを返す。"""
    y0, y1 = KIDS_BAND
    band = A[y0:y1]
    bg = kids_bg(band)
    d = np.sqrt(((band - bg) ** 2).sum(axis=2))
    g = band.mean(axis=2)
    # 細かいスケールの高周波 = 線画。霧の濃淡は大きなスケールなのでここに出ない
    ink = np.abs(g - ndi.gaussian_filter(g, 1.6))
    return band, bg, d, g, ndi.gaussian_filter(ink, 1.6)


def kid_seeds(g):
    """線画の密度の山を、一人ひとつの種として拾う。"""
    py0, py1, px0, px1 = KIDS_LABEL_PLATE
    ec = ndi.gaussian_filter(np.abs(g - ndi.gaussian_filter(g, 3.0)), 5)
    ec[py0:py1, px0:px1] = 0
    ef = ndi.gaussian_filter(ec, 7)
    peaks = (ef == ndi.maximum_filter(ef, size=46)) & (ef > 5.0)
    lab, n = ndi.label(peaks)
    pts = []
    for p in ndi.center_of_mass(peaks, lab, range(1, n + 1)):
        if all((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 > 44 ** 2 for q in pts):
            pts.append((float(p[0]), float(p[1])))
    return pts


def matte(sil, d, rgb, bg, pad=3):
    inner = ndi.binary_erosion(sil, disk(2))
    soft = np.clip((d - 5.0) / 13.0, 0, 1)
    alpha = ndi.gaussian_filter(
        np.where(inner, 1.0, np.where(sil, np.maximum(soft, 0.3), 0.0)), 0.8) * sil
    return trim(defringe(rgb, alpha, bg), alpha, pad=pad)


def kid_regions(A, g, e2):
    """線画マスクと、種ごとの縄張り地図を作る。"""
    py0, py1, px0, px1 = KIDS_LABEL_PLATE
    ink = e2 > INK
    ink[py0:py1, px0:px1] = False
    pts = kid_seeds(g)
    # 種から最近傍で縄張りを割る。隣の子を巻き込まないための仕切り
    mk = np.zeros(g.shape, np.int32)
    for i, (sy, sx) in enumerate(pts):
        mk[int(round(sy)), int(round(sx))] = i + 1
    _, (iy, ix) = ndi.distance_transform_edt(mk == 0, return_indices=True)
    return ink, mk[iy, ix], pts


def kid_silhouette(ink, terr_map, i, sy, sx):
    # 縄張りで刈ってから閉じる。順番が逆だと隣との隙間の霧が体として埋まる
    m = ink & ndi.binary_dilation(terr_map == i + 1, disk(KID_GROW))
    m = ndi.binary_opening(
        ndi.binary_fill_holes(ndi.binary_closing(m, disk(INK_CLOSE))), disk(3))
    lab, n = ndi.label(m)
    if not n:
        return None
    sid = lab[int(round(sy)), int(round(sx))]
    if sid == 0:
        sid = int(np.argmax(ndi.sum(m, lab, range(1, n + 1)))) + 1
    sil = ndi.binary_fill_holes(lab == sid)
    return sil if sil.sum() >= 1800 else None


def cut_kids(A):
    band, bg, d, g, e2 = kids_fields(A)
    ink, terr_map, pts = kid_regions(A, g, e2)

    out = []
    for ax, ay in KID_ANCHORS:
        cand = [(i, p) for i, p in enumerate(pts)
                if abs(p[1] - ax) <= ANCHOR_TOL and abs(p[0] + KIDS_BAND[0] - ay) <= ANCHOR_TOL]
        if not cand:
            print(f'  ! anchor ({ax},{ay}) に対応する種が無い')
            continue
        i, (sy, sx) = cand[0]
        sil = kid_silhouette(ink, terr_map, i, sy, sx)
        if sil is None:
            continue
        t = matte(sil, d, band, bg)
        if t is not None:
            out.append((ax, to_image(*t)))

    out.sort(key=lambda r: r[0])        # 元絵の並び順で番号を振る
    return [im for _, im in out]


def crowd_strip(A):
    """群れをまとめて一枚の透過 PNG にしたもの。背景や見出しに敷く用。

    一人ずつに割らないので、隣同士が繋がっても構わない。ここでは重なりは
    問題ではなく、むしろ「ワラワラ」の見た目そのものになる。
    """
    band, bg, d, g, e2 = kids_fields(A)
    ink, terr_map, pts = kid_regions(A, g, e2)

    # 帯を丸ごと1枚のマスクにすると、子と子の間の霧まで体として繋がってしまう。
    # 一人ずつ切ってから重ねると、間の霧は誰のものでもないので残らない。
    # 一人分にしては大きすぎるものは霧を抱えているので、群れにも入れない
    m = np.zeros(g.shape, bool)
    for i, (sy, sx) in enumerate(pts):
        s = kid_silhouette(ink, terr_map, i, sy, sx)
        if s is not None and 2500 <= s.sum() <= 7500:
            m |= s
    return to_image(*matte(m, d, band, bg, pad=6))


# --- 走る子供(コマ割り) ---------------------------------------------------
# こちらの元絵は最初からアルファが入っているので、抜く仕事は無い。やることは
# 「どこにコマがあるか」を見つけて、8コマを揺れないように揃えることだけ。

def run_num(path):
    m = re.search(r'\((\d+)\)', os.path.basename(path))
    return int(m.group(1)) if m else 0


def run_sheets():
    # ファイル名の (1)...(10) は文字列順だと (10) が (2) より前に来る
    return sorted(glob.glob(os.path.join(RUN_SRC, '*.png')), key=lambda p: (run_num(p), p))


def run_boxes(im):
    """アルファの島を1コマとして拾い、上段→下段、左→右の順に並べる。

    元絵は等間隔に見えて実際はコマが列の境をまたいでいるので、4等分では切れる。
    """
    a = np.asarray(im)[:, :, 3]
    lab, _ = ndi.label(a > 16)
    boxes = []
    for i, sl in enumerate(ndi.find_objects(lab)):
        if (lab[sl] == i + 1).sum() < RUN_MIN_AREA:
            continue
        boxes.append((sl[1].start, sl[0].start, sl[1].stop, sl[0].stop))
    mid = im.height / 2
    boxes.sort(key=lambda b: (0 if b[1] < mid else 1, b[0]))
    return boxes


def cut_runners():
    """10人ぶんのコマを、全員で共通のキャンバスに揃えて返す。

    共通にするのは CSS のため。1枚あたりの寸法が同じなら、走者の要素は
    全員同じ大きさでよく、background-size も一つで済む。
    """
    sheets = []
    for path in run_sheets():
        im = Image.open(path).convert('RGBA')
        boxes = run_boxes(im)
        if len(boxes) != RUN_FRAMES:
            print(f'  ! {os.path.basename(path)}: コマが {len(boxes)} 個 '
                  f'({RUN_FRAMES} 個のはず) — 飛ばす')
            continue
        frames = [im.crop(b) for b in boxes]
        if run_num(path) in RUN_FLIP:
            # コマごとに反転する。シートごと反転すると各段の左右が入れ替わり、
            # コマ順が逆になって走りが巻き戻しになる
            frames = [f.transpose(Image.FLIP_LEFT_RIGHT) for f in frames]
        sheets.append(frames)
    if not sheets:
        return [], (0, 0)

    cw = max(f.width for s in sheets for f in s)
    ch = max(f.height for s in sheets for f in s)
    scale = RUN_HEIGHT / ch
    out_w, out_h = max(1, round(cw * scale)), RUN_HEIGHT

    out = []
    for s in sheets:
        frames = []
        for f in s:
            # 接地を揃える(影が地面にある)。横は中央。ここがずれるとコマ送りで跳ねる
            canvas = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
            canvas.paste(f, ((cw - f.width) // 2, ch - f.height), f)
            frames.append(canvas.resize((out_w, out_h), Image.LANCZOS))
        out.append(frames)
    return out, (out_w, out_h)


def strip(frames):
    """コマを横一列に並べた1枚。CSS の steps() でそのまま送れる形。"""
    w, h = frames[0].size
    sheet = Image.new('RGBA', (w * len(frames), h), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        sheet.paste(f, (i * w, 0), f)
    return sheet


# --- スプライトシート -------------------------------------------------------

def pack(images, cols, path_png, path_json, gap=2):
    cw = max(im.width for _, im in images) + gap
    ch = max(im.height for _, im in images) + gap
    rows = (len(images) + cols - 1) // cols
    sheet = Image.new('RGBA', (cw * cols, ch * rows), (0, 0, 0, 0))
    frames = {}
    for k, (name, im) in enumerate(images):
        x, y = (k % cols) * cw, (k // cols) * ch
        sheet.paste(im, (x, y), im)
        frames[name] = {'x': x, 'y': y, 'w': im.width, 'h': im.height}
    sheet.save(path_png)
    with open(path_json, 'w', encoding='utf-8') as f:
        json.dump({'image': os.path.basename(path_png),
                   'cell': {'w': cw, 'h': ch},
                   'frames': frames}, f, ensure_ascii=False, indent=2)


def main():
    A = np.asarray(Image.open(SRC).convert('RGB')).astype(np.float32)
    for sub in ('daruma', 'kids', 'runners', 'sheet'):
        os.makedirs(os.path.join(OUT, sub), exist_ok=True)

    manifest = {'daruma': {}, 'icons': {}, 'kids': [], 'crowd': None, 'runners': {}}

    sprites = []
    for name, y0, y1 in BANDS:
        for side, cfg in SIDES.items():
            res = cut_daruma(A, y0, y1, cfg['x0'], cfg['x1'], cfg['flanks'])
            img = place(to_image(*res), DARUMA_CANVAS)
            rel = f'daruma/{name}-{side}.png'
            img.save(os.path.join(OUT, rel))
            manifest['daruma'].setdefault(name, {})[side] = rel
            sprites.append((f'{name}-{side}', img))
            if side == 'right':
                icon = fit(to_image(*res), ICON_SIZE)
                irel = f'daruma/icon-{name}.png'
                icon.save(os.path.join(OUT, irel))
                manifest['icons'][name] = irel
        print(f'daruma {name}: ok')

    pack(sprites, 4, os.path.join(OUT, 'sheet', 'daruma-sheet.png'),
         os.path.join(OUT, 'sheet', 'daruma-sheet.json'))

    kids = cut_kids(A)
    kid_sprites = []
    for k, im in enumerate(kids, 1):
        rel = f'kids/kid-{k:02d}.png'
        im.save(os.path.join(OUT, rel))
        manifest['kids'].append({'file': rel, 'w': im.width, 'h': im.height})
        kid_sprites.append((f'kid-{k:02d}', im))
        print(f'kid-{k:02d}: {im.width}x{im.height}')
    pack(kid_sprites, 6, os.path.join(OUT, 'sheet', 'kids-sheet.png'),
         os.path.join(OUT, 'sheet', 'kids-sheet.json'))

    crowd = crowd_strip(A)
    crowd.save(os.path.join(OUT, 'kids', 'crowd.png'))
    manifest['crowd'] = 'kids/crowd.png'

    runners, (rw, rh) = cut_runners()
    manifest['runners'] = {'count': len(runners), 'frames': RUN_FRAMES,
                           'frame': {'w': rw, 'h': rh}, 'files': []}
    for k, frames in enumerate(runners, 1):
        rel = f'runners/run-{k:02d}.png'
        strip(frames).save(os.path.join(OUT, rel))
        frames[0].save(os.path.join(OUT, f'runners/still-{k:02d}.png'))
        manifest['runners']['files'].append(rel)
        print(f'run-{k:02d}: {RUN_FRAMES}コマ {rw}x{rh}')

    with open(os.path.join(OUT, 'assets.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f'\ndaruma 8 / kids {len(kids)} / crowd 1 / runners {len(runners)}  -> {OUT}')


if __name__ == '__main__':
    main()
