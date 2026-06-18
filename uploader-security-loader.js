import express from "express";

const originalPost = express.application.post;

express.application.post = function guardedPost(path, ...handlers) {
  if (path !== "/upload-pdf-to-record") {
    return originalPost.call(this, path, ...handlers);
  }

  const guardedHandlers = handlers.map((handler) => {
    if (typeof handler !== "function") return handler;
    return function uploaderTokenGuard(req, res, next) {
      const token = process.env.PDF_UPLOADER_TOKEN || "";
      if (!token) {
        res.status(403).json({
          success: false,
          action_attempted: "upload_pdf_to_record",
          message: "Public PDF upload route is disabled until PDF_UPLOADER_TOKEN is configured.",
          safe_fallback: "Use the authenticated MCP upload tool after refreshing the app, or configure PDF_UPLOADER_TOKEN in Railway before using the public HTTP route."
        });
        return;
      }
      return handler(req, res, next);
    };
  });

  return originalPost.call(this, path, ...guardedHandlers);
};
