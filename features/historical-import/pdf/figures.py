"""Conservative figure regions; retain a drawing-page fallback when separation is uncertain."""
import cv2
import numpy as np
import pymupdf
import re


LABELS = {'drawing': '说明书附图', 'abstract': '摘要附图', 'body_figure': '正文插图',
          'table': '正文表格', 'formula': '正文公式'}

# Drawing captions usually sit below their figure. Discourage a caption from
# claiming components of the next figure below it.
DRAWING_BELOW_CAPTION_PENALTY = 8


def body_clip(page):
    # CNIPA's content starts around y=63 on an A4 page; y=774 is the footer.
    return pymupdf.Rect(page.rect.x0, page.rect.y0 + page.rect.height * .07,
                        page.rect.x1, page.rect.y0 + page.rect.height * .91)


def formula_text(text):
    compact = ''.join(text.split())
    # Do not turn ordinary paragraphs containing a single symbol into images.
    return bool(compact and not re.search(r'[\u4e00-\u9fff]', compact)
                and len(compact) < 180 and
                (re.search(r'[=＝∑∫√±≤≥→⇌∂∞α-ωΑ-Ω]', compact)
                 or re.search(r'(?:[CHNOSPF]\d+){2,}', compact)))


def embedded_regions(page, clip):
    result = []
    for image in page.get_image_info():
        rectangle = pymupdf.Rect(image['bbox'])
        intersection = rectangle & clip
        # Exclude logos/page numbers and whole scanned pages. Partial overlap
        # must not make a real image disappear when it crosses a crop boundary.
        if (rectangle.get_area() > 500 and rectangle.height > 22 and
                rectangle.get_area() < page.rect.get_area() * .8 and
                intersection.get_area() >= rectangle.get_area() * .9):
            result.append(intersection)
    return result


def sms_embedded_regions(page, clip):
    """Return embedded body image occurrences in PDF content-stream order.

    Unlike general figure detection, small images are retained: CNIPA inline
    formula symbols may be only a few points high. Repeated uses remain separate.
    """
    result = []
    for image in page.get_image_info(xrefs=True):
        rectangle = pymupdf.Rect(image['bbox'])
        if rectangle.is_empty:
            continue
        if (rectangle.get_area() < page.rect.get_area() * .8 and
                (rectangle & clip).get_area() >= rectangle.get_area() * .9):
            result.append((rectangle, image.get('xref', 0)))
    return result


def regions(page, clip, reader):
    embedded = embedded_regions(page, clip)
    pix = page.get_pixmap(dpi=120, clip=clip, colorspace=pymupdf.csGRAY, alpha=False)
    gray = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    ink = (gray < 210).astype(np.uint8) * 255
    scale_x, scale_y = pix.width / clip.width, pix.height / clip.height
    text_boxes = [pymupdf.Rect(block[:4]) for block in page.get_text('blocks', clip=clip)
                  if block[6] == 0 and not formula_text(block[4])]
    if not text_boxes and reader.ocr_enabled and not embedded:
        result = reader.ensure_engine()(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR))
        if result.boxes is not None:
            for box, text in zip(result.boxes, result.txts or []):
                if formula_text(text):
                    continue
                x0, y0 = box.min(axis=0)
                x1, y1 = box.max(axis=0)
                text_boxes.append(pymupdf.Rect(x0 / scale_x + clip.x0, y0 / scale_y + clip.y0, x1 / scale_x + clip.x0, y1 / scale_y + clip.y0))
    for box in text_boxes:
        box &= clip
        if box.is_empty:
            continue
        x0, y0 = int((box.x0-clip.x0)*scale_x), int((box.y0-clip.y0)*scale_y)
        x1, y1 = int((box.x1-clip.x0)*scale_x)+1, int((box.y1-clip.y0)*scale_y)+1
        ink[max(0,y0):y1, max(0,x0):x1] = 0
    mask = cv2.dilate(ink, np.ones((9,9), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x,y,w,h = cv2.boundingRect(contour)
        if w >= pix.width * .06 and h >= pix.height * .035 and w*h >= 300:
            boxes.append(pymupdf.Rect(x/scale_x+clip.x0,y/scale_y+clip.y0,(x+w)/scale_x+clip.x0,(y+h)/scale_y+clip.y0))
    changed = True
    while changed:
        changed = False
        for i in range(len(boxes)):
            for j in range(i+1,len(boxes)):
                a,b = boxes[i],boxes[j]
                expanded = pymupdf.Rect(a.x0-18,a.y0-18,a.x1+18,a.y1+18)
                if expanded.intersects(b):
                    boxes[i] |= boxes.pop(j)
                    changed = True
                    break
            if changed:
                break
    # Keep nearby reference numbers and arrows around the graphical strokes.
    # Include raster and vector candidates together, never return early for a footer image.
    boxes.extend(embedded)
    return [pymupdf.Rect(box.x0-15,box.y0-15,box.x1+15,box.y1+15) & clip for box in sorted(boxes,key=lambda b:(b.y0,b.x0))]


def body_regions(page, clip, reader):
    candidates = []
    for table in page.find_tables(clip=clip).tables:
        if table.row_count >= 2 and table.col_count >= 2:
            candidates.append((pymupdf.Rect(table.bbox), 'table'))
    for rectangle in embedded_regions(page, clip):
        pix = page.get_pixmap(dpi=90,clip=rectangle,colorspace=pymupdf.csGRAY,alpha=False)
        gray = np.frombuffer(pix.samples,dtype=np.uint8).reshape(pix.height,pix.width)
        ink = (gray < 180).astype(np.uint8) * 255
        horizontal = cv2.morphologyEx(ink,cv2.MORPH_OPEN,np.ones((1,max(20,pix.width//5)),np.uint8))
        vertical = cv2.morphologyEx(ink,cv2.MORPH_OPEN,np.ones((max(20,pix.height//5),1),np.uint8))
        crossings = cv2.bitwise_and(horizontal,vertical)
        count, _ = cv2.connectedComponents(crossings)
        candidates.append((rectangle, 'table' if count > 6 else 'body_figure'))
    for block in page.get_text('blocks', clip=clip):
        if block[6] == 0 and formula_text(block[4]):
            candidates.append((pymupdf.Rect(block[:4]), 'formula'))
    # Remaining strokes retain vector chemical structures, equations and scan
    # graphics. Their semantic class is deliberately left as body_figure.
    for rectangle in regions(page, clip, reader):
        if not any(rectangle.intersects(existing) for existing, _ in candidates):
            candidates.append((rectangle, 'body_figure'))
    output = []
    for rectangle, role in sorted(candidates, key=lambda item: (item[0].y0, item[0].x0)):
        rectangle = pymupdf.Rect(rectangle.x0-6,rectangle.y0-6,rectangle.x1+6,rectangle.y1+6) & clip
        overlapping = next((i for i, (old, _) in enumerate(output) if old.intersects(rectangle)), None)
        if overlapping is None:
            output.append((rectangle, role))
        else:
            old, old_role = output[overlapping]
            output[overlapping] = (old | rectangle, 'table' if 'table' in (role,old_role) else old_role)
    return output


def drawing_regions(page, reader):
    """Associate complete graphical bodies with captions before choosing crop bounds."""
    clip = body_clip(page)
    pix = page.get_pixmap(dpi=120, clip=clip, colorspace=pymupdf.csGRAY, alpha=False)
    gray = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    ink = gray < 210
    sx, sy = pix.width / clip.width, pix.height / clip.height
    captions = []
    pattern = re.compile(r'^(?:图|圖|Fig\.?|Figure)\s*(\d+)\s*(?:[（(]?([a-zA-Z])[）)]?)?(?:\s*[:：].{0,60})?$', re.I)
    caption_boxes = {}
    def caption(rectangle, text):
        match = pattern.fullmatch(text.strip())
        if match:
            center = (rectangle.x0 + rectangle.x1) / 2, (rectangle.y0 + rectangle.y1) / 2
            label = re.sub(r'\s+', '', re.match(r'^(?:图|圖|Fig\.?|Figure)\s*\d+\s*(?:[（(]?[a-zA-Z][）)]?)?', text.strip(), re.I)[0])
            point = (int((center[0]-clip.x0)*sx), int((center[1]-clip.y0)*sy), label)
            if any(old[2]==label and abs(old[0]-point[0])<20*sx and abs(old[1]-point[1])<20*sy for old in captions):
                return
            captions.append(point)
            caption_boxes[point] = rectangle
    for block in page.get_text('dict', clip=clip)['blocks']:
        for line in block.get('lines', []):
            caption(pymupdf.Rect(line['bbox']), ''.join(span['text'] for span in line['spans']))
    # A partial text layer must not prevent OCR from finding the remaining names.
    expected = len(embedded_regions(page,clip))
    if reader.ocr_enabled and len({item[2] for item in captions}) < max(2,expected):
        result = reader.ensure_engine()(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR))
        for box, text in zip(result.boxes if result.boxes is not None else [], result.txts or []):
            x0,y0 = box.min(axis=0)
            x1,y1 = box.max(axis=0)
            caption(pymupdf.Rect(x0/sx+clip.x0,y0/sy+clip.y0,x1/sx+clip.x0,y1/sy+clip.y0), text)
    if len({item[2] for item in captions}) < 2:
        return [(clip, captions[0][2] if captions else None, 'drawing-page-body')]

    def by_caption(bounds, labels):
        """Attach ink components to caption anchors before creating crop boundaries."""
        x0,y0,x1,y1 = bounds
        unique = list({c[2]:c for c in labels}.values())
        if len(unique)<2:
            return None
        local = ink[y0:y1,x0:x1].astype(np.uint8)
        # Exclude caption text from graphical ownership, then restore it in each crop.
        for c in labels:
            r = caption_boxes[c]
            ax,bx = max(0,int((r.x0-clip.x0)*sx)-x0-2),min(x1-x0,int((r.x1-clip.x0)*sx)-x0+3)
            ay,by = max(0,int((r.y0-clip.y0)*sy)-y0-2),min(y1-y0,int((r.y1-clip.y0)*sy)-y0+3)
            if ax<bx and ay<by:
                local[ay:by,ax:bx] = 0
        count,_,stats,_ = cv2.connectedComponentsWithStats(cv2.dilate(local,np.ones((3,3),np.uint8)))
        groups = {c:[] for c in unique}
        for index in range(1,count):
            x,y,w,h,area = stats[index]
            if area<5:
                continue
            x,y = x+x0,y+y0
            # Most patent figure names sit below their drawing. Prefer those
            # anchors, while allowing horizontally arranged figures.
            def cost(c):
                dx = max(x-c[0],c[0]-(x+w),0)/sx
                dy = abs(c[1]-(y+h))/sy
                return dx*2+dy+(max(y-c[1],0)/sy)*DRAWING_BELOW_CAPTION_PENALTY
            # When a name below the component is available, do not let an
            # earlier name claim ink from the next drawing. This also keeps
            # detached chart ticks with the chart below the previous caption.
            below = [c for c in unique if c[1] >= y+h-3*sy]
            owner = min(below or unique,key=cost)
            # A connected stroke crossing several names is ambiguous: retain the page.
            inside = [c for c in unique if x<=c[0]<=x+w and y<=c[1]<=y+h]
            if len(inside)>1:
                return None
            groups[owner].append((x,y,x+w,y+h))
        result = []
        for c,boxes in groups.items():
            if not boxes:
                return None
            bx0,by0 = min(b[0] for b in boxes),min(b[1] for b in boxes)
            bx1,by1 = max(b[2] for b in boxes),max(b[3] for b in boxes)
            if bx1-bx0<30*sx or by1-by0<30*sy:
                return None
            r = caption_boxes[c]
            bx0=min(bx0,int((r.x0-clip.x0)*sx)); by0=min(by0,int((r.y0-clip.y0)*sy))
            bx1=max(bx1,int((r.x1-clip.x0)*sx)+1); by1=max(by1,int((r.y1-clip.y0)*sy)+1)
            result.append((max(x0,bx0-2),max(y0,by0-2),min(x1,bx1+2),min(y1,by1+2),[c]))
        # Do not create overlapping crops that would still contain the other image.
        for i,a in enumerate(result):
            for b in result[i+1:]:
                if min(a[2],b[2])-max(a[0],b[0])>2 and min(a[3],b[3])-max(a[1],b[1])>2:
                    return None
        return sorted(result,key=lambda b:(b[1],b[0]))

    # Assign the entire page before any cut: a wide blank gap between a
    # drawing and its caption must never become a partition boundary.
    # Non-overlapping body+caption bounds support columns and mixed layouts.
    parts = by_caption((0,0,pix.width,pix.height),captions)
    if parts is None:
        return [(clip, '、'.join(dict.fromkeys(c[2] for c in captions)), 'drawing-page-body')]
    if len(parts)<2:
        return [(clip, None, 'drawing-page-body')]
    output = []
    for x0,y0,x1,y1,labels in parts:
        # Keep all strokes, reference numbers and captions in each partition.
        ys,xs = np.where(ink[y0:y1,x0:x1])
        if not len(xs):
            return [(clip, None, 'drawing-page-body')]
        rectangle = pymupdf.Rect(clip.x0+(x0+xs.min())/sx-8,clip.y0+(y0+ys.min())/sy-8,
                                 clip.x0+(x0+xs.max()+1)/sx+8,clip.y0+(y0+ys.max()+1)/sy+8)
        partition = pymupdf.Rect(clip.x0+x0/sx,clip.y0+y0/sy,clip.x0+x1/sx,clip.y0+y1/sy)
        rectangle &= partition & clip
        if rectangle.width < 30 or rectangle.height < 30 or rectangle.get_area() < 1800:
            # A caption alone is not a figure; reject the entire proposed split.
            return [(clip, None, 'drawing-page-body')]
        output.append((rectangle, '、'.join(dict.fromkeys(c[2] for c in labels)), 'figure-caption-region'))
    return output


def clean_drawing_image(page, rectangle, pix, reader):
    """Remove recognized figure captions and trim outer whitespace, preserving diagram labels."""
    gray = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width).copy()
    sx, sy = pix.width / rectangle.width, pix.height / rectangle.height
    pattern = re.compile(r'^(?:图|圖|Fig\.?|Figure)\s*\d+\s*(?:[（(]?[a-zA-Z][）)]?)?$', re.I)
    boxes = []
    for block in page.get_text('dict', clip=rectangle)['blocks']:
        for line in block.get('lines', []):
            text = ''.join(span['text'] for span in line['spans']).strip()
            if pattern.fullmatch(text):
                r = pymupdf.Rect(line['bbox'])
                boxes.append(((r.x0-rectangle.x0)*sx, (r.y0-rectangle.y0)*sy,
                              (r.x1-rectangle.x0)*sx, (r.y1-rectangle.y0)*sy))
    if reader.ocr_enabled:
        result = reader.ensure_engine()(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR))
        for box, text in zip(result.boxes if result.boxes is not None else [], result.txts or []):
            if pattern.fullmatch(text.strip()):
                x0,y0 = box.min(axis=0)
                x1,y1 = box.max(axis=0)
                boxes.append((x0,y0,x1,y1))
    for x0,y0,x1,y1 in boxes:
        pad = max(2, round(pix.xres / 150))
        gray[max(0,int(y0)-pad):min(pix.height,int(y1)+pad+1),
             max(0,int(x0)-pad):min(pix.width,int(x1)+pad+1)] = 255
    ys,xs = np.where(gray < 210)
    if not len(xs):
        raise ValueError('删除图号后未检测到图形，请人工核对')
    margin = max(8, round(pix.xres * .04))
    return gray[max(0,ys.min()-margin):min(pix.height,ys.max()+margin+1),
                max(0,xs.min()-margin):min(pix.width,xs.max()+margin+1)]


def extract_figures(doc, drawing_pages, directory, number, args, reader, headers=None, drawing_only=False):
    images = []
    counters = dict.fromkeys(LABELS, 0)
    used_names = set()
    def save(page_index, rectangle, role, method, label=None):
        import hashlib
        counters[role] += 1
        figure_name = label or ('图' if role in ('drawing','abstract') else {'body_figure':'正文图','table':'表','formula':'公式'}[role]) + str(counters[role])
        prefix = '摘要' if role == 'abstract' else '说明书'
        # Windows filenames must be flat, valid, and unique within one patent.
        safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', figure_name).rstrip(' .')
        stem = prefix + '-' + safe_name
        filename = stem + '.png'
        suffix = 1
        while filename in used_names:
            suffix += 1
            filename = f'{stem}-第{page_index+1}页-{suffix}.png'
        used_names.add(filename)
        pix = doc[page_index].get_pixmap(dpi=args.dpi, clip=rectangle, colorspace=pymupdf.csGRAY, alpha=False)
        target = directory / filename
        width, height = pix.width, pix.height
        if role == 'drawing' and getattr(args, 'clean_drawing', False):
            clean = clean_drawing_image(doc[page_index], rectangle, pix, reader)
            height, width = clean.shape
            success, encoded = cv2.imencode('.png', clean)
            if not success:
                raise ValueError('附图保存失败')
            target.write_bytes(encoded.tobytes())
        else:
            pix.save(target)
        images.append(dict(file_name=filename,page=page_index+1,width=width,height=height,
                           content_hash=hashlib.sha256(target.read_bytes()).hexdigest(),image_role=role,
                           figure_label=figure_name,
                           bbox=list(rectangle),extraction_method=method))
    for index in drawing_pages:
        page = doc[index]
        for rectangle,label,method in drawing_regions(page,reader):
            save(index,rectangle,'drawing',method,label)
    if drawing_only:
        return images
    # Explicit abstract-figure pages, or a cover's lower illustration area.
    for index,page in enumerate(doc):
        if index in drawing_pages:
            continue
        header = (headers or {}).get(index)
        if header is None:
            header = reader.read(page, header=True) if index == 0 else page.get_text()
        labelled = '摘要附图' in ''.join(header.split())
        compact = ''.join(header.split())
        body_header = ('说明书' in compact or '說明書' in compact) and '附图' not in compact
        if not labelled and (index != 0 or body_header):
            if body_header:
                for box, role in body_regions(page, body_clip(page), reader):
                    save(index,box,role,'body-region')
            continue
        clip = body_clip(page)
        if not labelled:
            clip.y0 = page.rect.y0 + page.rect.height*.38
        # On a digital cover, bibliographic rules and text are not abstract figures.
        # Embedded illustrations are reliable; scanned covers use graphical regions.
        boxes = embedded_regions(page,clip) if not labelled and page.get_text().strip() else regions(page,clip,reader)
        for box in boxes:
            if not labelled and (box.y0 <= clip.y0+8 or box.width >= clip.width*.9
                                 or box.width < 45 or box.height < 45):
                # Cover bibliographic tables have page-wide rules crossing the crop boundary.
                continue
            save(index,box,'abstract','figure-region')
    return images
