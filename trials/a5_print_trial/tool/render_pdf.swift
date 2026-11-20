import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3, let doc = CGPDFDocument(URL(fileURLWithPath: args[1]) as CFURL) else { print("cannot open"); exit(1) }
let scale: CGFloat = args.count > 3 ? CGFloat(Double(args[3])!) : 2.5
print("pages:", doc.numberOfPages)
for n in 1...doc.numberOfPages {
  guard let page = doc.page(at: n) else { continue }
  let box = page.getBoxRect(.mediaBox)
  print("page", n, "size pt:", box.width, "x", box.height, " mm:", String(format: "%.1f x %.1f", box.width/72*25.4, box.height/72*25.4))
  let w = Int(box.width*scale), h = Int(box.height*scale)
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(CGColor(red:1,green:1,blue:1,alpha:1)); ctx.fill(CGRect(x:0,y:0,width:w,height:h))
  ctx.scaleBy(x: scale, y: scale)
  ctx.drawPDFPage(page)
  let img = ctx.makeImage()!
  let url = URL(fileURLWithPath: "\(args[2])_p\(n).png")
  let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, img, nil); CGImageDestinationFinalize(dest)
}
