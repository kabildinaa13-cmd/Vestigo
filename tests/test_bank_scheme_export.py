import sys,unittest,io,zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from export_editable_scheme import export
class BankSchemeExport(unittest.TestCase):
    def test_iban_is_editable_account_not_fictional_bin(self):
        identifier="IBAN:KZ86125KZT5004100100"
        node={"bin":identifier,"name":"Счёт синтетического владельца","levelIndex":0,"knownObject":True}
        payload={"nodes":[node],"edges":[],"root":node,"rule":"Только материалы дела","audit":{}}
        content=export({"focusBin":identifier,"payload":payload,"diagramPayload":payload,"scopeLabel":"Дело","depth":1,"diagramLayout":{"positions":{identifier:{"x":40,"y":40,"width":340,"height":160}},"labels":[],"stageWidth":480,"stageHeight":280}})
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            drawing=archive.read("xl/drawings/drawing1.xml").decode("utf-8")
            self.assertIn("IBAN KZ86125KZT5004100100",drawing)
            self.assertNotIn("БИН/ИИН IBAN:",drawing)
            self.assertIn("<xdr:sp>",drawing)
if __name__=="__main__":unittest.main()
