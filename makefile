run-server:
	@npm run dev

run-demo-app:
	@cd demo-app && npm run dev

build-demo-app:
	@mkdir -p hosts/demo-app
	@cd demo-app && npm run build
	@rm -rf hosts/demo-app
	@mv demo-app/dist hosts/demo-app

test-ssr:
	@echo "Testing SSR..."
	@curl -s http://localhost:8080 -H "Origin: https://demo-app.com" | grep -q "<title>" && echo "PASS" || echo "FAIL"

test-cache:
	@echo "Testing cache..."
	@curl -s http://localhost:8080 -H "Origin: https://demo-app.com" > /dev/null
	@curl -s -o /dev/null -w "Cache response: %{time_total}s\n" http://localhost:8080 -H "Origin: https://demo-app.com"

test-static:
	@echo "Testing static..."
	@curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/vite.svg -H "Origin: https://demo-app.com"

test-health:
	@curl -s http://localhost:8080/health | python3 -m json.tool

test-all: test-ssr test-cache test-static test-health
