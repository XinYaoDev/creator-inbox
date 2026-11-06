"""Synthetic OCR acceptance fixtures; contains no customer data."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

root = Path(__file__).resolve().parent.parent / 'data' / 'knowledge-qa'
root.mkdir(parents=True, exist_ok=True)
font = '/System/Library/Fonts/STHeiti Medium.ttc'
image = Image.new('RGB', (1800, 1100), 'white')
draw = ImageDraw.Draw(image)
draw.text((100, 90), '青禾书店 · 营业与预约说明', font=ImageFont.truetype(font, 66), fill='#162e21')
for index, line in enumerate([
    '营业时间：周一至周日 09:00 - 18:00。',
    '周末活动需要提前一天预约。',
    '预约方式：在线留言，由工作人员确认。',
    '地址：杭州市文一街 88 号。',
    '本页是合成验收资料，不是真实商户信息。',
    'BOOKSTORE HOURS: 09:00 - 18:00',
]):
    draw.text((100, 245 + index * 115), line, font=ImageFont.truetype(font, 45), fill='#111111')
image.save(root / '青禾书店-扫描图片.png')
pdf = canvas.Canvas(str(root / '青禾书店-纯扫描件.pdf'), pagesize=(900, 550))
pdf.drawImage(ImageReader(image), 0, 0, width=900, height=550)
pdf.showPage()
pdf.save()
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
mixed = canvas.Canvas(str(root / '青禾书店-混合文档.pdf'), pagesize=(900, 550))
mixed.drawImage(ImageReader(image), 0, 0, width=900, height=550)
mixed.showPage()
mixed.setFont('STSong-Light', 22)
mixed.drawString(60, 450, '退改说明：预约确认前可直接取消。已确认活动需联系工作人员。')
mixed.drawString(60, 400, '此页有文字层，应直接提取，不重复进行 OCR。本文件仅用于项目功能验收。')
mixed.showPage()
mixed.showPage()
mixed.save()
print(root)
