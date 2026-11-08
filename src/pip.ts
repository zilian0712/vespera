type PresentationVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

export function supportsPictureInPicture(video: HTMLVideoElement, page: Document = document) {
  const element = video as PresentationVideo;
  return (!!page.pictureInPictureEnabled && typeof element.requestPictureInPicture === 'function')
    || (!!element.webkitSetPresentationMode && !!element.webkitSupportsPresentationMode?.('picture-in-picture'));
}

export function isPictureInPicture(video: HTMLVideoElement, page: Document = document) {
  return page.pictureInPictureElement === video || (video as PresentationVideo).webkitPresentationMode === 'picture-in-picture';
}

export async function togglePictureInPicture(video: HTMLVideoElement, page: Document = document) {
  const element = video as PresentationVideo;
  if (page.pictureInPictureElement === video) {
    await page.exitPictureInPicture();
  } else if (element.webkitPresentationMode === 'picture-in-picture' && element.webkitSetPresentationMode) {
    element.webkitSetPresentationMode('inline');
  } else if (page.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
    await video.requestPictureInPicture();
  } else if (element.webkitSetPresentationMode && element.webkitSupportsPresentationMode?.('picture-in-picture')) {
    element.webkitSetPresentationMode('picture-in-picture');
  } else throw new Error('当前浏览器不支持画中画，请使用支持此功能的系统浏览器');
}
