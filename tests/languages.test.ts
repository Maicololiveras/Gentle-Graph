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

it("traces a WPF DataContext and both Prism callbacks despite unrelated MVC folder names", t => {
  const opts = project(t, {
    "UI/wpfDiagram.xaml": '<UserControl x:Class="GIS.wpfDiagram"><Button Command="{Binding CalculateKnightSupportCommand}"/></UserControl>',
    "UI/wpfDiagram.xaml.cs": "public partial class wpfDiagram {\n public wpfDiagram() { DataContext = new DiagramVM(); }\n}",
    "Product/DiagramVM.cs": [
      "public class DiagramVM {", "public ICommand CalculateKnightSupportCommand { get; }",
      "public DiagramVM() {", "CalculateKnightSupportCommand = new DelegateCommand<object>(",
      "this.CalculateKngSup, CanCalculateKngSup);", "}",
      "private void CalculateKngSup(object arg) { CalculateItemKnightSupports(); }",
      "private bool CanCalculateKngSup(object arg) { return true; }", "}"
    ].join("\n"),
    "Calc/Knight.cs": "public class Knight {\npublic void CalculateItemKnightSupports() {}\n}",
    "Tests/KnightSupportTests.cs": "public class KnightSupportTests {\n public void ChecksHelper(Knight calculator) { calculator.CalculateItemKnightSupports(); }\n}",
    "Controllers/Root.cs":"class Root {}", "Services/S.cs":"class S {}"
  });
  const summary = graphGuide("architecture", opts).architecture!;
  assert.match(summary, /WPF MVVM/);
  assert.doesNotMatch(summary, /MVC/);
  assert.ok(graphInspect("DiagramVM", opts).some(r => r.callers.some(s => s.file === "UI/wpfDiagram.xaml.cs")));
  const command = graphInspect("CalculateKnightSupportCommand", opts)[0];
  for (const name of ["DiagramVM.CalculateKngSup","DiagramVM.CanCalculateKngSup"]) {
    assert.ok(command.callees.some(r => r.name === name));
    assert.ok(graphImpact(name, opts).affectedFiles.includes("UI/wpfDiagram.xaml"));
  }
  assert.ok(!graphImpact("CalculateKngSup",opts).relatedTests.includes("Tests/KnightSupportTests.cs"));
  assert.ok(graphImpact("CalculateItemKnightSupports",opts).relatedTests.includes("Tests/KnightSupportTests.cs"));
});

it("reports exact binding, callback roles and test call sites for the GIS command shape", t => {
  const opts = project(t, {
    "Diagram.xaml": ['<View x:Class="GIS.Diagram">','<!-- {Binding CalculateCommand} -->',
      '<Button Command="{Binding CalculateCommand}"/>','</View>'].join("\n"),
    "DiagramVM.cs": ["public class DiagramVM {","public ICommand CalculateCommand { get; }",
      "public DiagramVM() {","CalculateCommand = new DelegateCommand(", "CalculateKngSup, CanCalculateKngSup);","}",
      "public void CalculateKngSup() { CalculateItemKnightSupports(); }",
      "public bool CanCalculateKngSup() { return true; }","public void CalculateItemKnightSupports() {}","}"].join("\n"),
    "KnightSupportTests.cs": ["public class KnightSupportTests {","[Test] public void Check() { var vm = new DiagramVM();",
      "// CalculateItemKnightSupports();","vm.CalculateItemKnightSupports();","vm.CalculateItemKnightSupports();","}","}"].join("\n")
  });
  const result = graphInspect("CalculateCommand", { ...opts, depth: 2 })[0];
  const evidence = result.evidence!;
  assert.deepEqual(evidence.filter(s => s.file === "Diagram.xaml").map(s => [s.line,s.text]), [[3,"{Binding CalculateCommand}"]]);
  assert.deepEqual(evidence.filter(s => s.file === "DiagramVM.cs").map(s => [s.line,s.role,s.target]),
    [[4,"Execute","DiagramVM.CalculateKngSup"],[4,"CanExecute","DiagramVM.CanCalculateKngSup"]]);
  const tests = evidence.filter(s => s.role === "Test call");
  assert.deepEqual(tests.map(s => [s.line,s.target]), [[4,"CalculateItemKnightSupports"],[5,"CalculateItemKnightSupports"]]);
  assert.equal(result.callers.find(c => c.file === "Diagram.xaml")?.line, 3);
  assert.deepEqual(tests[0].via, ["CalculateCommand", "DiagramVM.CalculateKngSup"]);
  const direct = graphInspect("CalculateItemKnightSupports", opts)[0].evidence?.filter(s=>s.role === "Test call");
  assert.deepEqual(direct, tests.map(s => ({ ...s, via: undefined })));
});

it("attributes command test evidence to the receiver type, including homonymous domain helpers", t => {
  const opts = project(t, {
    "FirstVM.cs": ["public class FirstVM {","public ICommand SaveCommand { get; }",
      "public FirstVM() { SaveCommand = new DelegateCommand(Save); }",
      "public void Save() { Measure(); text.ToString(); items.Contains(1); }",
      "public void Measure() {}","}"].join("\n"),
    "Other.cs": ["public class Other {","public void Measure() {}","public string ToString() { return null; }","public bool Contains(int x) { return true; }","}"].join("\n"),
    "MixedTests.cs": ["public class MixedTests {","public void Check(FirstVM first, Other other) {",
      "first.Measure();","other.Measure();","other.ToString();","other.Contains(1);","unknown.Measure();","}","}"].join("\n")
  });
  const result = graphInspect("SaveCommand",{...opts,depth:2})[0];
  assert.deepEqual(result.evidence!.filter(s=>s.role === "Test call").map(s=>[s.qualified,s.line]), [["FirstVM.Measure",3]]);
  assert.ok(!result.callees.some(c=>c.file === "Other.cs"));
});

for (const jit of [false, true]) it("scopes BOM command evidence and removes absent test paths, JIT=" + jit, t => {
  const files: Record<string,string> = {
    "BillOfMaterialVM.Tests/GlobalUsings.cs":"global using System;",
    "BillOfMaterialVM.Tests/DocumentOutputRegressionTests.cs":"class DocumentOutputRegressionTests {}",
    "BillOfMaterialVMTests.cs":"class BillOfMaterialVMTests {}"
  };
  for (const name of ["BillOfMaterial","Accessories"]) {
    files[name+"VM.cs"] = "public class "+name+"VM {\npublic ICommand GenerateCommand { get; }\n}";
    files[name+".xaml"] = '<View x:Class="'+name+'"><Button Command="{Binding GenerateCommand}"/></View>';
    files[name+".xaml.cs"] = "public partial class "+name+" {\npublic "+name+"() { DataContext = new "+name+"VM(); }\n}";
  }
  if (jit) for(let i=0;i<505;i++) files["f"+i+".ts"] = "export const x = 1;";
  const opts = project(t, files);
  const git = (...args: string[]) => execFileSync("git",args,{cwd:opts.projectRoot,stdio:"pipe"});
  git("init","-q"); git("add","."); git("-c","user.name=test","-c","user.email=t@example.invalid","commit","-qm","fixture");
  const key = "BillOfMaterialVM.cs#GenerateCommand";
  assert.ok(graphImpact("GenerateCommand",opts).alternatives?.includes(key));
  const inspect = graphInspect(key,opts)[0];
  assert.deepEqual(inspect.evidence?.filter(s=>s.role === "Binding").map(s=>s.file),["BillOfMaterial.xaml"]);
  assert.deepEqual(inspect.callers.map(s=>s.file),["BillOfMaterial.xaml"]);
  const before = graphImpact(key,opts);
  assert.deepEqual(before.namedTests,["BillOfMaterialVMTests.cs"]);
  assert.deepEqual(before.dependencyTests,[]);
  assert.ok(!before.affectedFiles.includes("Accessories.xaml"));
  fs.unlinkSync(path.join(opts.projectRoot,"BillOfMaterialVMTests.cs"));
  for(const query of [key,"BillOfMaterialVM.cs"]) assert.deepEqual(graphImpact(query,opts).relatedTests,[]);
});

it("resolves explicit C# and TypeScript implementations separately from consumers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-contract-"));
  try {
    for (const [file, source] of Object.entries({
      "IPort.cs": "public interface IPort {}",
      "Adapter.cs": "public class Adapter\n  : IPort\n{}",
      "Consumer.cs": "public class Consumer {\n public Consumer(IPort port) {}\n}",
      "port.ts": "export interface IPort {}",
      "adapter.ts": "import {IPort} from './port';\nexport class TsAdapter implements IPort {}"
    })) fs.writeFileSync(path.join(root,file),source);
    const result = graphInspect("IPort", { projectRoot:root });
    assert.deepEqual(result.find(m=>m.symbol.file==="IPort.cs")?.implementations.map(s=>s.name), ["Adapter"]);
    assert.deepEqual(result.find(m=>m.symbol.file==="port.ts")?.implementations.map(s=>s.name), ["TsAdapter"]);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

it("distinguishes declared Rust and Python implementations from ordinary consumers", t => {
  const root = project(t,{
    "port.rs":"pub trait Port {}",
    "database.rs":"pub struct Db;\nimpl Port for Db {}",
    "consumer.rs":"fn consume(port: &dyn Port) {}",
    "port.py":"class Port:\n    pass",
    "database.py":"class Database(Port):\n    pass",
    "consume.py":"def consume(port: Port):\n    pass"
  });
  for (const [file,name] of [["port.rs","Db"],["port.py","Database"]]) {
    const [match] = graphInspect(file+"#Port",root);
    assert.deepEqual(match.implementations.map(x=>x.name),[name]);
    assert(isTestFile(file.endsWith(".rs")?"tests/port.rs":"tests/test_port.py"));
  }
});

it("returns a compact opt-in subgraph and excludes build directories", async t => {
  const opts = project(t,{"billing.py":"def billing():\n    return amount()\ndef amount():\n    return 1", "out/generated.py":"def billing(): pass"});
  const { formatGuide } = await import("../lib/gentle-graph/format.ts");
  const guide = graphGuide("billing",{...opts,includeSnippets:true});
  assert(guide.subgraph.some(m=>m.symbol.name==="billing" && m.callees.some(c=>c.name==="amount")));
  assert(!guide.subgraph.some(m=>m.symbol.file.startsWith("out/")));
  assert(formatGuide(guide).length<=3000);
  assert.equal(graphGuide("billing",opts).subgraph,undefined);
});
