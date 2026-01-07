run-server:
	@npm run dev

run-demo-app:
	@cd demo-app && npm run dev

build-demo-app:
	@mkdir -p hosts/demo-app
	@cd demo-app && npm run build
	@rm -rf hosts/demo-app
	@mv demo-app/dist hosts/demo-app

test-csr:
	@echo "Testing CSR /..."
	@curl http://localhost:8080 -H "Origin: https://demo-app.com"
	@echo "Testing CSR /posts..."
	@curl http://localhost:8080/posts -H "Origin: https://demo-app.com"

test-ssr:
	@echo "Testing SSR /..."
	@curl http://localhost:8080 -H "Origin: https://demo-app.com" -H "User-Agent: Googlebot"
	@echo "Testing SSR /posts..."
	@curl http://localhost:8080/posts -H "Origin: https://demo-app.com" -H "User-Agent: Googlebot"

test-all-routes: test-csr test-ssr
