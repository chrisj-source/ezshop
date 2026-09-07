/**
 * Client-side image pipeline.
 *
 * Photos are resized in the browser before they are uploaded: a 2048px long
 * edge for the record, and a 400px thumbnail for grids. A 4 MB phone photo
 * becomes about 350 KB, so uploads finish on shop wifi and a file with two
 * hundred photos does not take a minute to open.
 *
 * window.Photos.prepare(File) -> { full: Blob, thumb: Blob, width, height }
 */
window.Photos = (function () {
  var FULL_EDGE = 2048;
  var THUMB_EDGE = 400;
  var FULL_QUALITY = 0.82;
  var THUMB_QUALITY = 0.7;

  function isImage(file) {
    return file && /^image\//.test(file.type) && !/heic|heif/i.test(file.type);
  }

  /** HEIC comes off iPhones when the camera is set to "High Efficiency". */
  function isHeic(file) {
    return file && (/heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name || ''));
  }

  function loadBitmap(file) {
    if (window.createImageBitmap) {
      // Honours EXIF orientation, unlike an <img> in some browsers.
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }

  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
      img.src = url;
    });
  }

  function scaleTo(source, edge, quality) {
    var w = source.width, h = source.height;
    var k = Math.min(1, edge / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * k));
    var ch = Math.max(1, Math.round(h * k));

    var canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, cw, ch);

    return new Promise(function (resolve) {
      if (canvas.toBlob) {
        canvas.toBlob(function (b) { resolve({ blob: b, width: cw, height: ch }); }, 'image/jpeg', quality);
      } else {
        var data = canvas.toDataURL('image/jpeg', quality);
        var bytes = atob(data.split(',')[1]);
        var arr = new Uint8Array(bytes.length);
        for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        resolve({ blob: new Blob([arr], { type: 'image/jpeg' }), width: cw, height: ch });
      }
    });
  }

  /**
   * Returns the pair to upload. Anything that is not a decodable image — a PDF,
   * a HEIC the browser cannot read — passes through untouched.
   */
  function prepare(file) {
    if (!isImage(file)) {
      return Promise.resolve({
        full: file, thumb: null, width: null, height: null,
        passthrough: true, heic: isHeic(file)
      });
    }

    return loadBitmap(file).then(function (src) {
      return Promise.all([
        scaleTo(src, FULL_EDGE, FULL_QUALITY),
        scaleTo(src, THUMB_EDGE, THUMB_QUALITY)
      ]).then(function (out) {
        if (src.close) src.close();
        return {
          full: out[0].blob,
          thumb: out[1].blob,
          width: out[0].width,
          height: out[0].height,
          passthrough: false,
          originalBytes: file.size,
          bytes: out[0].blob.size
        };
      });
    }).catch(function () {
      return {
        full: file, thumb: null, width: null, height: null,
        passthrough: true, heic: isHeic(file)
      };
    });
  }

  /** Build a FormData for the document upload endpoint. */
  function appendTo(fd, index, file, prepared) {
    var base = (file.name || 'photo.jpg').replace(/\.[^.]+$/, '');
    if (prepared.passthrough) {
      fd.append('file' + index, prepared.full, file.name || 'file');
      return;
    }
    fd.append('file' + index, prepared.full, base + '.jpg');
    if (prepared.thumb) fd.append('thumb' + index, prepared.thumb, base + '.thumb.jpg');
    if (prepared.width) fd.append('dim' + index, prepared.width + 'x' + prepared.height);
  }

  function prepareAll(files) {
    var list = Array.prototype.slice.call(files);
    return Promise.all(list.map(prepare)).then(function (prepped) {
      return list.map(function (f, i) { return { file: f, prepared: prepped[i] }; });
    });
  }

  function bytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  return {
    prepare: prepare, prepareAll: prepareAll, appendTo: appendTo,
    isImage: isImage, isHeic: isHeic, bytes: bytes,
    FULL_EDGE: FULL_EDGE, THUMB_EDGE: THUMB_EDGE
  };
})();
