"""Gerador mínimo de DOCX (Office Open XML) usando só a biblioteca padrão.

Suporta o que o relatório precisa: título, títulos de seção, parágrafos,
tabelas com cabeçalho, imagens PNG com legenda e rodapé com nº de página.
Evita depender de python-docx/lxml no executável.
"""

from __future__ import annotations

import io
import struct
import zipfile
from datetime import datetime, timezone
from xml.sax.saxutils import escape

W_NS = (
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
)
EMU_PER_CM = 360_000
TEXT_WIDTH_TWIPS = 9354  # A4, margens 2,5 cm (esq.) e 2 cm (dir.)


def _t(text: str) -> str:
    # caracteres de controle não são válidos em XML
    clean = "".join(ch for ch in str(text) if ch in "\t\n" or ord(ch) >= 32)
    return escape(clean)


def png_size(data: bytes) -> tuple[int, int]:
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("Imagem inválida (esperado PNG).")
    w, h = struct.unpack(">II", data[16:24])
    if not (0 < w < 20000 and 0 < h < 20000):
        raise ValueError("Imagem com dimensões inválidas.")
    return w, h


class DocxBuilder:
    def __init__(self, title: str = "Relatório", author: str = ""):
        self.title = title
        self.author = author
        self.body: list[str] = []
        self.images: list[bytes] = []

    # ---------------------------------------------------------------- blocos
    def _run(self, text: str, bold: bool = False, italic: bool = False, size: int | None = None,
             color: str | None = None) -> str:
        props = []
        if bold:
            props.append("<w:b/>")
        if italic:
            props.append("<w:i/>")
        if color:
            props.append(f'<w:color w:val="{color}"/>')
        if size:
            props.append(f'<w:sz w:val="{size}"/>')
        rpr = f"<w:rPr>{''.join(props)}</w:rPr>" if props else ""
        parts = str(text).split("\n")
        out = []
        for i, part in enumerate(parts):
            if i:
                out.append("<w:br/>")
            out.append(f'<w:t xml:space="preserve">{_t(part)}</w:t>')
        return f"<w:r>{rpr}{''.join(out)}</w:r>"

    def paragraph(self, text: str = "", style: str | None = None, bold: bool = False, italic: bool = False,
                  align: str | None = None, color: str | None = None, size: int | None = None) -> None:
        ppr = []
        if style:
            ppr.append(f'<w:pStyle w:val="{style}"/>')
        if align:
            ppr.append(f'<w:jc w:val="{align}"/>')
        p = f"<w:pPr>{''.join(ppr)}</w:pPr>" if ppr else ""
        self.body.append(f"<w:p>{p}{self._run(text, bold, italic, size, color) if text else ''}</w:p>")

    def heading(self, text: str, level: int = 1) -> None:
        self.paragraph(text, style="Title" if level == 0 else f"Heading{level}")

    def table(self, header: list[str] | None, rows: list[list[str]], widths: list[float] | None = None,
              first_col_bold: bool = False, font_size: int = 18) -> None:
        ncols = len(header) if header else (len(rows[0]) if rows else 1)
        if widths is None:
            widths = [1.0] * ncols
        total = sum(widths)
        tw = [int(TEXT_WIDTH_TWIPS * w / total) for w in widths]
        grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in tw)

        def cell(text: str, width: int, bold: bool = False, shade: str | None = None, right: bool = False) -> str:
            tcpr = f'<w:tcW w:w="{width}" w:type="dxa"/>'
            if shade:
                tcpr += f'<w:shd w:val="clear" w:color="auto" w:fill="{shade}"/>'
            jc = '<w:jc w:val="right"/>' if right else ""
            ppr = f'<w:pPr><w:spacing w:before="20" w:after="20"/>{jc}</w:pPr>'
            return f"<w:tc><w:tcPr>{tcpr}</w:tcPr><w:p>{ppr}{self._run(text, bold=bold, size=font_size)}</w:p></w:tc>"

        xml = [
            "<w:tbl><w:tblPr><w:tblStyle w:val=\"Grade\"/>"
            f'<w:tblW w:w="{TEXT_WIDTH_TWIPS}" w:type="dxa"/>'
            "<w:tblBorders>"
            + "".join(f'<w:{b} w:val="single" w:sz="4" w:space="0" w:color="A0A0A0"/>'
                      for b in ("top", "left", "bottom", "right", "insideH", "insideV"))
            + "</w:tblBorders><w:tblCellMar><w:left w:w=\"70\" w:type=\"dxa\"/><w:right w:w=\"70\" w:type=\"dxa\"/>"
            "</w:tblCellMar></w:tblPr>"
            f"<w:tblGrid>{grid}</w:tblGrid>"
        ]
        if header:
            xml.append('<w:tr><w:trPr><w:tblHeader/></w:trPr>'
                       + "".join(cell(h, tw[i], bold=True, shade="DCE6F2") for i, h in enumerate(header))
                       + "</w:tr>")
        for row in rows:
            cells = []
            for i in range(ncols):
                txt = row[i] if i < len(row) else ""
                cells.append(cell(txt, tw[i], bold=first_col_bold and i == 0))
            xml.append(f"<w:tr><w:trPr><w:cantSplit/></w:trPr>{''.join(cells)}</w:tr>")
        xml.append("</w:tbl>")
        self.body.append("".join(xml))
        self.paragraph("")

    def image(self, png: bytes, caption: str = "", width_cm: float = 16.0) -> None:
        w, h = png_size(png)
        self.images.append(png)
        n = len(self.images)
        width_cm = min(width_cm, 16.0)
        cx = int(width_cm * EMU_PER_CM)
        cy = int(cx * h / w)
        max_cy = int(22 * EMU_PER_CM)
        if cy > max_cy:
            cx, cy = int(cx * max_cy / cy), max_cy
        drawing = (
            f'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
            f'<wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{n}" name="Figura {n}"/>'
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            f'<pic:pic><pic:nvPicPr><pic:cNvPr id="{n}" name="image{n}.png"/><pic:cNvPicPr/></pic:nvPicPr>'
            f'<pic:blipFill><a:blip r:embed="rIdImg{n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
            "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
        )
        self.body.append(f'<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr>{drawing}</w:p>')
        if caption:
            self.paragraph(caption, style="Caption", align="center")

    # ---------------------------------------------------------------- saída
    def _document(self) -> str:
        sect = (
            '<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/>'
            '<w:pgSz w:w="11906" w:h="16838"/>'
            '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1418" w:header="567" w:footer="567" w:gutter="0"/>'
            "</w:sectPr>"
        )
        return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {W_NS}><w:body>'
                + "".join(self.body) + sect + "</w:body></w:document>")

    def _footer(self) -> str:
        fld = ('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
               '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>')
        return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr {W_NS}>'
                f'<w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="right"/></w:pPr>'
                f'{self._run(self.title + "  ·  página ", size=16, color="666666")}{fld}</w:p></w:ftr>')

    @staticmethod
    def _styles() -> str:
        def pstyle(sid, name, size, bold=False, color=None, before=0, after=120, keep=False, italic=False):
            rpr = f'<w:sz w:val="{size}"/>' + ("<w:b/>" if bold else "") + ("<w:i/>" if italic else "")
            if color:
                rpr += f'<w:color w:val="{color}"/>'
            ppr = f'<w:spacing w:before="{before}" w:after="{after}"/>' + ("<w:keepNext/>" if keep else "")
            return (f'<w:style w:type="paragraph" w:styleId="{sid}"><w:name w:val="{name}"/>'
                    f'<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
                    f"<w:pPr>{ppr}</w:pPr><w:rPr>{rpr}</w:rPr></w:style>")

        return (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/>'
            '<w:sz w:val="21"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault>'
            '<w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
            '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
            + pstyle("Title", "Title", 40, bold=True, color="1F3864", after=80)
            + pstyle("Subtitle", "Subtitle", 24, color="595959", after=240)
            + pstyle("Heading1", "heading 1", 28, bold=True, color="1F3864", before=320, after=120, keep=True)
            + pstyle("Heading2", "heading 2", 23, bold=True, color="2E5496", before=200, after=80, keep=True)
            + pstyle("Caption", "caption", 18, italic=True, color="404040", after=200)
            + pstyle("Footer", "footer", 16, after=0)
            + pstyle("Note", "Note", 18, italic=True, color="7F6000")
            + '<w:style w:type="table" w:styleId="Grade"><w:name w:val="Table Grid"/>'
            '<w:tblPr><w:tblCellMar><w:left w:w="70" w:type="dxa"/><w:right w:w="70" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
            "</w:styles>"
        )

    def to_bytes(self) -> bytes:
        rels = "".join(
            f'<Relationship Id="rIdImg{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image{i}.png"/>'
            for i in range(1, len(self.images) + 1)
        )
        doc_rels = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
            f"{rels}</Relationships>"
        )
        content_types = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Default Extension="png" ContentType="image/png"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
            '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
            "</Types>"
        )
        root_rels = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
            "</Relationships>"
        )
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        core = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f"<dc:title>{_t(self.title)}</dc:title><dc:creator>{_t(self.author)}</dc:creator>"
            f'<dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>'
            "</cp:coreProperties>"
        )
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("[Content_Types].xml", content_types)
            z.writestr("_rels/.rels", root_rels)
            z.writestr("docProps/core.xml", core)
            z.writestr("word/document.xml", self._document())
            z.writestr("word/styles.xml", self._styles())
            z.writestr("word/footer1.xml", self._footer())
            z.writestr("word/_rels/document.xml.rels", doc_rels)
            for i, img in enumerate(self.images, start=1):
                z.writestr(f"word/media/image{i}.png", img, compress_type=zipfile.ZIP_STORED)
        return buf.getvalue()
