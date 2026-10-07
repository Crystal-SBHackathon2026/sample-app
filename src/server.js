const { createApp } = require("./app");

const port = Number(process.env.PORT || 8080);

createApp().listen(port, () => {
  console.log(`sample-app listening on ${port}`);
});
