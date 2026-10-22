const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  validateVideoUrl,
  userFacingVideoError,
} = require("../src/services/videoDelivery");

describe("videoDelivery", () => {
  it("accepts https mp4 URLs", () => {
    const result = validateVideoUrl(
      "https://res.cloudinary.com/demo/video/upload/dog.mp4"
    );
    assert.equal(result.ok, true);
  });

  it("rejects missing or invalid URLs", () => {
    assert.equal(validateVideoUrl("").ok, false);
    assert.equal(validateVideoUrl("not-a-url").ok, false);
    assert.equal(validateVideoUrl("ftp://example.com/a.mp4").ok, false);
  });

  it("userFacingVideoError explains Telegram URL fetch failures", () => {
    const err = new Error("Failed to get HTTP URL content");
    err.code = "TELEGRAM_SEND_VIDEO_FAILED";
    const msg = userFacingVideoError(err);
    assert.match(msg, /Cloudinary|Telegram|MP4|fallback/i);
  });

  it("userFacingVideoError handles invalid URL code", () => {
    const err = new Error("Video URL is missing.");
    err.code = "INVALID_VIDEO_URL";
    assert.match(userFacingVideoError(err), /demos\.json/i);
  });

  it("userFacingVideoError mentions size limit for VIDEO_TOO_LARGE", () => {
    const err = new Error(
      "Downloaded video is 65.9 MB; Telegram bot uploads are limited to ~50 MB."
    );
    err.code = "VIDEO_TOO_LARGE";
    assert.match(userFacingVideoError(err), /50 MB/i);
  });
});
