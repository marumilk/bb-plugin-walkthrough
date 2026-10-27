// A two-file pull request diff used across the tests.
export const PR_DIFF = `diff --git a/src/deliver.ts b/src/deliver.ts
index 1111111..2222222 100644
--- a/src/deliver.ts
+++ b/src/deliver.ts
@@ -10,4 +10,8 @@ export async function deliver(event: Event) {
   const body = serialize(event);
-  await post(event.url, body);
+  try {
+    await post(event.url, body);
+  } catch (error) {
+    await enqueueRetry(event, error);
+  }
   return true;
 }
@@ -40,4 +44,5 @@ function serialize(event: Event) {
   return JSON.stringify({
     id: event.id,
+    attempt: event.attempt,
   });
 }
diff --git a/src/queue.ts b/src/queue.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/queue.ts
@@ -0,0 +1,3 @@
+export async function enqueueRetry(event: Event, error: unknown) {
+  await queue.push({ event, error, at: Date.now() });
+}
`;
