"""Graded and cropped variants of the six example stills, so no page repeats the same look (docs/design/SITE_ENGAGE_5.md)."""
from PIL import Image, ImageEnhance, ImageChops, ImageOps
import os
# The six originals (1376 x 768 PNG, the owner's approved stills) are not in the repo: point STILLS at them.
# Writes the graded and cropped variants next to the six stills in components/site/samples/.
M=os.environ.get("STILLS","/home/user/state/media")
OUT=os.environ.get("OUT",os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","components","site","samples"))
def load(n): return Image.open(f"{M}/{n}.png").convert("RGB")
def tint(im, shadow, high, amt=0.35):
    # split-tone: blend a colour into shadows and one into highlights
    g=ImageOps.grayscale(im)
    sh=ImageChops.multiply(Image.new("RGB",im.size,shadow), Image.merge("RGB",(ImageOps.invert(g),)*3))
    hi=ImageChops.multiply(Image.new("RGB",im.size,high), Image.merge("RGB",(g,)*3))
    t=ImageChops.add(sh,hi)
    return Image.blend(im, t, amt)
def grade(im, sat=1.0, con=1.0, bri=1.0, mult=(1,1,1)):
    im=ImageEnhance.Color(im).enhance(sat); im=ImageEnhance.Contrast(im).enhance(con); im=ImageEnhance.Brightness(im).enhance(bri)
    r,g,b=im.split()
    r=r.point(lambda v:min(255,int(v*mult[0]))); g=g.point(lambda v:min(255,int(v*mult[1]))); b=b.point(lambda v:min(255,int(v*mult[2])))
    return Image.merge("RGB",(r,g,b))
def save(im,name,w=900,q=74,maxkb=60):
    h=round(im.size[1]*w/im.size[0]); im=im.resize((w,h),Image.LANCZOS)
    while True:
        p=f"{OUT}/{name}.webp"; im.save(p,"WEBP",quality=q,method=6)
        if os.path.getsize(p)<=maxkb*1024 or q<40: break
        q-=4
    print(name, im.size, os.path.getsize(p)//1024,"KB q",q)
# silkroad-dusk: right part with caravan, cool violet dusk
s=load("silkroad"); c=s.crop((330,120,1376,708)); c=grade(tint(c,(40,30,90),(255,190,150),0.5),sat=0.9,con=1.05,bri=0.92,mult=(0.95,0.95,1.08)); save(c,"silkroad-dusk")
# library-teal: left shelves, teal-green grade
l=load("library"); c=l.crop((0,100,1000,664)); c=grade(tint(c,(10,70,80),(255,215,160),0.45),sat=0.95,con=1.08,bri=0.95); save(c,"library-teal")
# valley-rose: pink mist
v=load("valley"); c=v.crop((200,0,1376,700)); c=grade(tint(c,(70,30,80),(255,170,170),0.5),sat=1.0,con=1.05); save(c,"valley-rose")
# nightmarket-cool: upper lanterns, cool blue
n=load("nightmarket"); c=n.crop((0,0,1376,620)); c=grade(tint(c,(10,30,90),(255,170,110),0.4),sat=1.0,con=1.05,mult=(0.95,1.0,1.1)); save(c,"nightmarket-cool")
# lighthouse-wide: landscape crop of the vertical frame, teal storm
h=load("lighthouse"); c=h.crop((0,300,768,300+432)); c=grade(tint(c,(8,60,70),(255,230,190),0.4),sat=1.05,con=1.08); save(c,"lighthouse-wide")
