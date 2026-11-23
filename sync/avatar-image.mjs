// The profile stores a data URL (maximum 200,000 characters), not an original upload.
export async function optimizeAvatar(file) {
  const types = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!types.includes(file.type)) throw new Error('Escolha uma imagem PNG, JPEG, WebP ou GIF.');
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('Escolha uma foto de até 25 MB.');
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (a, b) => String.fromCharCode(...bytes.slice(a, b));
  const valid = file.type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : file.type === 'image/png' ? ascii(1, 4) === 'PNG' && bytes[0] === 137 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10
    : file.type === 'image/webp' ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
    : ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (!valid) throw new Error('O conteúdo não corresponde ao formato da imagem.');
  let image;
  try {
    // Decode raster pixels only. EXIF orientation is applied by the browser.
    image = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (!image.width || !image.height || image.width * image.height > 50_000_000) throw new Error('Imagem acima de 50 megapixels. Reduza a resolução antes de selecionar.');
    const scale = Math.min(1, 512 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Prévia indisponível neste navegador.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [.85, .72, .55, .35]) {
      let result = canvas.toDataURL('image/webp', quality);
      if (!result.startsWith('data:image/webp;')) result = canvas.toDataURL('image/jpeg', quality);
      if (result.length <= 190000) return result;
    }
    throw new Error('Não foi possível reduzir esta imagem com segurança. Escolha outra foto.');
  } catch (error) {
    if (error.name === 'InvalidStateError' || error.name === 'EncodingError') throw new Error('Não foi possível abrir esta imagem. Escolha um arquivo válido.');
    throw error;
  } finally { image?.close(); }
}
