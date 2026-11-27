import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { graphGuide, graphImpact, graphInspect } from "../lib/gentle-graph/index.ts";
import { loadGraphIndex, clearMemoryCache } from "../lib/gentle-graph/store.ts";
import { isTestFile, parseSourceFile } from "../lib/gentle-graph/languages/registry.ts";

function project(t: TestContext, files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gentle-languages-"));
  t.after(() => { clearMemoryCache(root); fs.rmSync(root, { recursive: true, force: true }); });
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return { projectRoot: root };
}

it("TS and JS adapters expose class methods, defaults and re-exports in both parser modes", t => {
  const source = 'export default class Service {\n  run() { return work(); }\n}';
  for (const file of ["service.ts", "service.js"]) for (const preview of [true, false]) {
    const node = parseSourceFile(".", file, source, preview);
    assert.ok(node.symbols.some(s => s.name === "Service.run" && s.calls.includes("work")));
    assert.ok(node.exports.includes("default"));
  }
  const opts = project(t, {"service.ts": source, "public.ts": 'export * from "./service";', "__tests__/service.ts": 'import "./public";'});
  assert.ok(graphImpact("service.ts", opts).affectedFiles.includes("public.ts"));
  assert.ok(isTestFile("__tests__/service.ts"));
});

it("Python resolves relative modules and masks docstring calls", t => {
  const opts = project(t, {"app/repo.py":"def load_user():\n    return 1", "app/user.py":
    'from .repo import load_user\nclass User:\n    async def fetch(self):\n        """fake()"""\n        return load_user()',
    "tests/test_user.py":"from app.user import User"});
  const s = graphInspect("User.fetch", opts)[0];
  assert.deepEqual(s.symbol.calls, ["load_user"]);
  assert.ok(graphImpact("app/repo.py", opts).affectedFiles.includes("app/user.py"));
  assert.ok(graphImpact("app/user.py", opts).relatedTests.includes("tests/test_user.py"));
});

it("Go records block imports and receiver methods with short aliases", t => {
  const opts = project(t, {"store.go":'package data\nimport (\n "fmt"\n "my/pkg"\n)\ntype Store struct {}\nfunc (s *Store) Get() int { return load() }',
    "store_test.go":"package data\nfunc TestGet() { s.Get() }"});
  assert.equal(graphInspect("Get", opts)[0].symbol.name, "Store.Get");
  assert.ok(graphInspect("Store.Get", opts)[0].callers.some(r => r.name === "TestGet"));
  assert.deepEqual(loadGraphIndex(opts.projectRoot).files["store.go"].imports, ["fmt", "my/pkg"]);
  assert.ok(isTestFile("store_test.go"));
});

it("Rust registers impl and trait methods and recognizes integration tests", t => {
  const opts = project(t, {"src/client.rs":"use crate::auth;\nmod cache;\npub struct Client {}\nimpl Service for Client {\n pub async fn fetch() { auth(); }\n}",
    "tests/client_test.rs":"fn smoke() { client.fetch(); }"});
  const s = graphInspect("Client::fetch", opts)[0];
  assert.ok(s.symbol.exported && s.callers.some(r => r.name === "smoke"));
  assert.deepEqual(loadGraphIndex(opts.projectRoot).files["src/client.rs"].imports, ["crate::auth","cache"]);
  assert.ok(isTestFile("tests/client_test.rs"));
});

const wpf = {
  "Views/OrderView.xaml": '<UserControl x:Class="Shop.Views.OrderView" xmlns:vm="clr-namespace:Shop.ViewModels" xmlns:controls="clr-namespace:Shop.Controls" d:DataContext="{d:DesignInstance Type=vm:OrderViewModel}">\n<Button Command="{Binding SaveOrderCommand}" Content="{Binding Customer.Name}" />\n<controls:PriceBadge Style="{StaticResource PriceStyle}" />\n</UserControl>',
  "Views/OrderView.xaml.cs": "namespace Shop.Views;\npublic partial class OrderView {}",
  "ViewModels/OrderViewModel.cs": "global using Shop.Services;\nnamespace Shop.ViewModels;\npublic partial class OrderViewModel\n{\n public OrderViewModel(IOrderService service) { _service = service; }\n [ObservableProperty]\n private string customer;\n [RelayCommand]\n private async Task SaveOrderAsync() { await _service.SaveAsync(); }\n}",
  "Services/OrderService.cs": "namespace Shop.Services {\n public interface IOrderService {}\n public class OrderService : IOrderService {}\n}",
  "Tests/OrderViewModelTests.cs":"public class OrderViewModelTests {\n public void Creates() { new OrderViewModel(null); }\n}",
  "Shop.Tests/Behavior.cs": "public class Behavior {}",
  "obj/Generated.cs":"class Unwanted {}",
  "Outside.g.i.cs":"class Other {}",
  "Outside.Designer.cs":"class Other {}"
};
for (const jit of [false, true]) it("WPF traces service injection, generated commands and XAML consumers in " + (jit ? "JIT" : "full"), t => {
  const opts = project(t, wpf);
  if (jit) {
    for (let i = 0; i < 510; i++) fs.writeFileSync(path.join(opts.projectRoot, "extra" + i + ".cs"), "class Extra" + i + " {}");
    const git = (...args: string[]) => execFileSync("git", args, {cwd: opts.projectRoot, stdio: "pipe"});
    git("init", "-q"); git("add", "."); git("-c","user.name=fixture","-c","user.email=t@example.invalid","commit","-qm","fixture");
  }
  const view = "Views/OrderView.xaml";
  assert.ok(graphImpact("SaveOrderCommand", opts).directCallers.some(c => c.file === view));
  assert.ok(graphInspect("OrderViewModel", opts).some(r => r.callers.some(c => c.file === view)));
  assert.ok(graphImpact("SaveOrderAsync", opts).affectedFiles.includes(view));
  const impact = graphImpact("OrderService", opts);
  assert.ok(impact.affectedFiles.includes("ViewModels/OrderViewModel.cs"));
  assert.ok(impact.relatedTests.includes("Tests/OrderViewModelTests.cs"));
  const modules = graphGuide("agregar pantalla o comando de ordenes",opts).recommendedModules.map(m => m.file);
  for (const f of [view,"ViewModels/OrderViewModel.cs","Services/OrderService.cs"]) assert.ok(modules.includes(f), modules.join(", "));
  const files = loadGraphIndex(opts.projectRoot).files;
  assert.equal(files["ViewModels/OrderViewModel.cs"].namespace, "Shop.ViewModels");
  assert.ok(files["ViewModels/OrderViewModel.cs"].symbols.some(s => s.name === "Customer"));
  assert.ok(files[view].symbols[0].calls.includes("PriceBadge"));
  assert.ok(files[view].symbols[0].calls.includes("PriceStyle"));
  assert.ok(!files["obj/Generated.cs"] && !files["Outside.g.i.cs"] && !files["Outside.Designer.cs"]);
  assert.ok(isTestFile("Shop.Tests/Behavior.cs"));
  if (jit) assert.ok(Object.keys(files).length < 40);
});

it("indexes .NET DI registrations, generic constructor dependencies, events and WPF members", t => {
  const opts = project(t, {
    "Program.cs": "services.AddScoped<IOrderService, OrderService>();",
    "Editor.cs": [
      "namespace Shop {", "public class Editor : Behavior<TextBox> {",
      "public Editor(IRepository<Order> orders, IMediator mediator) {}", "public event EventHandler Changed;",
      "public static readonly DependencyProperty TextProperty = DependencyProperty.Register();",
      "public ICommand ApplyCommand { get; }", "}", "}"
    ].join("\n"),
    "Map.cs": "internal class Map : IValueConverter {}",
    "Handler.cs": "public class Handler : IRequestHandler<SaveOrder, Order> {}",
    "Meta.AssemblyInfo.cs": "public class Generated {}"
  });
  const profile = graphGuide("editor",opts);
  assert.match(profile.architecture!, /CQRS/);
  assert.match(profile.architecture!, /DI/);
  const nodes = loadGraphIndex(opts.projectRoot).files;
  const symbols = nodes["Editor.cs"].symbols;
  for (const name of ["TextProperty","Changed","ApplyCommand"]) assert.ok(symbols.some(s => s.name === name),name);
  const ctor = symbols.find(s=>s.name === "Editor.Editor")!;
  for (const dep of ["IRepository","IMediator"]) assert.ok(ctor.calls.includes(dep));
  assert.ok(nodes["Program.cs"].symbols.some(s => s.calls.includes("OrderService")));
  assert.ok(nodes["Handler.cs"].symbols[0].calls.includes("SaveOrder"));
  assert.ok(!nodes["Meta.AssemblyInfo.cs"]);
});
